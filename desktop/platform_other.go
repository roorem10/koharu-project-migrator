//go:build !windows

package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func projectLocations() []scanRoot {
	profile, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []scanRoot{{dir: filepath.Join(profile, "Documents"), documents: true}}
}

func openBrowser(url string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "open"
	}
	return exec.Command(command, url).Start()
}

func showError(text string) { fmt.Fprintln(os.Stderr, text) }

func isDataFile(_ string, mode fs.FileMode) bool { return mode.IsRegular() }

func ordinaryPath(root *os.Root, relative string) error {
	var prefix string
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		prefix = filepath.Join(prefix, part)
		info, err := root.Lstat(prefix)
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return fs.ErrPermission
		}
	}
	return nil
}

func openProjectFile(documents, project, relative string) (*os.File, int64, error) {
	root, err := os.OpenRoot(documents)
	if err != nil {
		return nil, 0, err
	}
	defer root.Close()
	if err = ordinaryPath(root, project); err != nil {
		return nil, 0, err
	}
	chapter, err := root.OpenRoot(project)
	if err != nil {
		return nil, 0, err
	}
	defer chapter.Close()
	if err = ordinaryPath(chapter, relative); err != nil {
		return nil, 0, err
	}
	info, err := chapter.Lstat(relative)
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() {
		return nil, 0, fs.ErrPermission
	}
	file, err := chapter.Open(relative)
	if err != nil {
		return nil, 0, err
	}
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		if err == nil {
			err = fs.ErrPermission
		}
		return nil, 0, err
	}
	return file, info.Size(), nil
}

func publishNew(dir *os.Root, _ resolvedRoot, temp, name string) error {
	return dir.Link(temp, name)
}
