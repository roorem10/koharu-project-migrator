package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var shell = syscall.NewLazyDLL("shell32.dll")
var kernel = syscall.NewLazyDLL("kernel32.dll")
var ole = syscall.NewLazyDLL("ole32.dll")

func shellThread() func() {
	runtime.LockOSThread()
	result, _, _ := ole.NewProc("CoInitializeEx").Call(0, 0x2|0x4)
	return func() {
		if result == 0 || result == 1 {
			ole.NewProc("CoUninitialize").Call()
		}
		runtime.UnlockOSThread()
	}
}

func knownFolder(id syscall.GUID) string {
	var ptr *uint16
	result, _, _ := shell.NewProc("SHGetKnownFolderPath").Call(uintptr(unsafe.Pointer(&id)), 0, 0, uintptr(unsafe.Pointer(&ptr)))
	if ptr != nil {
		defer ole.NewProc("CoTaskMemFree").Call(uintptr(unsafe.Pointer(ptr)))
	}
	if result != 0 || ptr == nil {
		return ""
	}
	n, _, _ := kernel.NewProc("lstrlenW").Call(uintptr(unsafe.Pointer(ptr)))
	return syscall.UTF16ToString(unsafe.Slice(ptr, int(n)))
}

func projectLocations() []scanRoot {
	release := shellThread()
	documents := knownFolder(syscall.GUID{Data1: 0xFDD39AD0, Data2: 0x238F, Data3: 0x46AF, Data4: [8]byte{0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7}})
	cloudDocs := knownFolder(syscall.GUID{Data1: 0x24D89E24, Data2: 0x2F19, Data3: 0x4534, Data4: [8]byte{0x9D, 0xDE, 0x6A, 0x66, 0x71, 0xFB, 0xB8, 0xFE}})
	release()
	profile, _ := os.UserHomeDir()
	roots := documentRoots(documents, cloudDocs, profile, os.Getenv("OneDriveConsumer"), os.Getenv("OneDrive"), os.Getenv("OneDriveCommercial"))
	for _, folder := range runningProjectFolders() {
		roots = append(roots, scanRoot{dir: folder, running: true})
	}
	for _, install := range []struct{ env, label string }{
		{"LOCALAPPDATA", "Koharu projects (per-user install)"},
		{"ProgramW6432", "Koharu projects (system install)"},
		{"ProgramFiles", "Koharu projects (system install)"},
		{"ProgramFiles(x86)", "Koharu projects (32-bit install)"},
	} {
		if base := os.Getenv(install.env); filepath.IsAbs(base) {
			roots = append(roots, scanRoot{dir: filepath.Join(base, "Koharu", "projects"), label: install.label})
		}
	}
	return roots
}

// Read only the executable location of Koharu instances in this Windows session.
// File names in CEF child processes can repeat; resolveRoots merges their folders.
func runningProjectFolders() []string {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer syscall.CloseHandle(snapshot)
	getSession := kernel.NewProc("ProcessIdToSessionId")
	var selfSession uint32
	ok, _, _ := getSession.Call(uintptr(os.Getpid()), uintptr(unsafe.Pointer(&selfSession)))
	if ok == 0 {
		return nil
	}
	query := kernel.NewProc("QueryFullProcessImageNameW")
	var folders []string
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = syscall.Process32First(snapshot, &entry); err == nil; err = syscall.Process32Next(snapshot, &entry) {
		if !strings.EqualFold(syscall.UTF16ToString(entry.ExeFile[:]), "koharu.exe") {
			continue
		}
		var session uint32
		ok, _, _ := getSession.Call(uintptr(entry.ProcessID), uintptr(unsafe.Pointer(&session)))
		if ok == 0 || session != selfSession {
			continue
		}
		const queryLimitedInformation = 0x1000
		process, err := syscall.OpenProcess(queryLimitedInformation, false, entry.ProcessID)
		if err != nil {
			continue
		}
		buf := make([]uint16, 32768)
		size := uint32(len(buf))
		ok, _, _ = query.Call(uintptr(process), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
		syscall.CloseHandle(process)
		if ok != 0 && size > 0 {
			exe := syscall.UTF16ToString(buf[:size])
			if strings.EqualFold(filepath.Base(exe), "koharu.exe") {
				folders = append(folders, filepath.Join(filepath.Dir(exe), "projects"))
			}
		}
	}
	return folders
}

func utf16(text string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(text)
	return p
}

func openBrowser(url string) error {
	release := shellThread()
	defer release()
	result, _, _ := shell.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(utf16("open"))), uintptr(unsafe.Pointer(utf16(url))), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("Windows could not open the default browser (code %d)", result)
	}
	return nil
}

func showError(text string) {
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(utf16(text))), uintptr(unsafe.Pointer(utf16("Koharu Project Migrator"))), 0x10)
}

func extendedPath(name string) string {
	if !strings.HasPrefix(name, `\\?\`) {
		if strings.HasPrefix(name, `\\`) {
			name = `\\?\UNC\` + name[2:]
		} else {
			name = `\\?\` + name
		}
	}
	return name
}

func isDataFile(name string, mode fs.FileMode) bool {
	if mode.IsRegular() {
		return true
	}
	if mode.Type() != fs.ModeIrregular {
		return false
	}
	// OneDrive Files On-Demand gives ordinary file contents a cloud reparse tag.
	name = extendedPath(name)
	var entry syscall.Win32finddata
	search, err := syscall.FindFirstFile(utf16(name), &entry)
	if err != nil {
		return false
	}
	syscall.FindClose(search)
	tag := entry.Reserved0
	return tag&0xffff0fff == 0x9000001a || tag == 0x80000021
}

// Compare opened handles, including the Documents root, so a configured
// redirect works while links encountered below Documents cannot change the file served.
func finalPath(f *os.File) (string, error) {
	proc := kernel.NewProc("GetFinalPathNameByHandleW")
	b := make([]uint16, 512)
	for {
		n, _, err := proc.Call(f.Fd(), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), 0)
		if n == 0 {
			return "", err
		}
		if n < uintptr(len(b)) {
			return syscall.UTF16ToString(b[:n]), nil
		}
		b = make([]uint16, n+1)
	}
}

func openProjectFile(documents, project, relative string) (*os.File, int64, error) {
	root, err := os.Open(documents)
	if err != nil {
		return nil, 0, err
	}
	defer root.Close()
	resolved, err := finalPath(root)
	if err != nil {
		return nil, 0, err
	}
	name := filepath.Join(documents, project, relative)
	info, err := os.Lstat(name)
	if err != nil {
		return nil, 0, err
	}
	if !isDataFile(name, info.Mode()) {
		return nil, 0, fs.ErrPermission
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, 0, err
	}
	actual, err := finalPath(file)
	if err != nil || !strings.EqualFold(filepath.Join(resolved, project, relative), actual) {
		file.Close()
		return nil, 0, fs.ErrPermission
	}
	info, err = file.Stat()
	if err != nil {
		file.Close()
		return nil, 0, err
	}
	if !isDataFile(name, info.Mode()) {
		file.Close()
		return nil, 0, fs.ErrPermission
	}
	return file, info.Size(), nil
}

// MoveFileW on the same volume refuses an existing target, including on drives
// without hard links. The staged file has already been flushed and closed.
func publishNew(dir *os.Root, target resolvedRoot, temp, name string) error {
	// On NTFS, link through the open directory handle. MoveFileW also
	// supports common external drives without hard-link support.
	err := dir.Link(temp, name)
	if err == nil || os.IsExist(err) {
		return err
	}
	if err := unchangedDirectory(target); err != nil {
		return err
	}
	return syscall.MoveFile(utf16(extendedPath(filepath.Join(dir.Name(), temp))), utf16(extendedPath(filepath.Join(dir.Name(), name))))
}
