package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type receipt struct {
	Name string `json:"name"`
	Path string `json:"path"`
}
type savedFile struct {
	receipt receipt
	info    fs.FileInfo
}

func validOutputName(name string) bool {
	return utf8.ValidString(name) && len(name) > 4 && strings.HasSuffix(name, ".khr") && filepath.IsLocal(name) &&
		!strings.ContainsAny(name, "/\\<>:\"|?*") && strings.IndexFunc(name, unicode.IsControl) < 0
}

func (app *localApp) saveProject(w http.ResponseWriter, r *http.Request, id string) {
	app.catalog.mu.RLock()
	target, ok := app.catalog.destinations[id]
	app.catalog.mu.RUnlock()
	if !ok {
		http.Error(w, "Rescan project folders and choose the destination again.", 404)
		return
	}
	name, err := url.PathUnescape(r.Header.Get("X-Koharu-Name"))
	if err != nil || !validOutputName(name) {
		http.Error(w, "This output filename is invalid.", 400)
		return
	}
	var header [100]byte
	if _, err := io.ReadFull(r.Body, header[:]); err != nil || !bytes.Equal(header[:16], []byte("SQLite format 3\x00")) ||
		binary.BigEndian.Uint16(header[16:18]) != 16384 || string(header[68:72]) != "KHRU" {
		http.Error(w, "The converted data does not contain a Koharu project header.", 400)
		return
	}
	size := int64(binary.BigEndian.Uint32(header[28:32])) * 16384
	if size < 16384 || (r.ContentLength >= 0 && r.ContentLength != size) {
		http.Error(w, "The project data is incomplete.", 400)
		return
	}
	dir, err := os.OpenRoot(target.dir)
	if err != nil {
		http.Error(w, "The projects folder could not be opened. Rescan or choose another destination.", 403)
		return
	}
	defer dir.Close()
	stat, err := dir.Stat(".")
	if err != nil || !os.SameFile(target.info, stat) {
		http.Error(w, "The destination folder changed. Rescan before saving.", 409)
		return
	}
	var seed [16]byte
	rand.Read(seed[:])
	temp := ".koharu-migrator-" + hex.EncodeToString(seed[:]) + ".tmp"
	f, err := dir.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		http.Error(w, "Windows could not create a file in this folder. Check write access or use Download .khr.", 403)
		return
	}
	defer dir.Remove(temp)
	defer f.Close()
	hash := sha256.New()
	sink := io.MultiWriter(f, hash)
	if _, err = sink.Write(header[:]); err != nil {
		http.Error(w, "Could not write the project. Check available disk space.", 507)
		return
	}
	expected := size - int64(len(header))
	n, err := io.Copy(sink, io.LimitReader(r.Body, expected+1))
	if err != nil || n != expected {
		http.Error(w, "Saving stopped before the whole project could be written. Check disk space and retry.", 400)
		return
	}
	if err = f.Sync(); err != nil {
		http.Error(w, "Could not finish writing the project. Check available disk space.", 507)
		return
	}
	if err = f.Close(); err != nil {
		http.Error(w, "Could not close the finished project file.", 500)
		return
	}
	if err = r.Context().Err(); err != nil {
		return
	}
	key := id + "\x00" + name + "\x00" + hex.EncodeToString(hash.Sum(nil))
	out, err := app.publish(dir, target, temp, name, key)
	if err != nil {
		http.Error(w, "Could not place the completed file in this folder. Use Download .khr or choose a writable destination.", 403)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(out)
}

func (app *localApp) publish(dir *os.Root, target resolvedRoot, temp, name, key string) (receipt, error) {
	app.saveMu.Lock()
	defer app.saveMu.Unlock()
	// A repeat request for identical bytes in this session can reuse the file only
	// while it is unchanged. An active SQLite journal may contain newer edits.
	if last, ok := app.saved[key]; ok {
		now, err := dir.Lstat(last.receipt.Name)
		_, wal := dir.Lstat(last.receipt.Name + "-wal")
		_, journal := dir.Lstat(last.receipt.Name + "-journal")
		if err == nil && now.Mode().IsRegular() && os.SameFile(now, last.info) && now.Size() == last.info.Size() && now.ModTime().Equal(last.info.ModTime()) &&
			errors.Is(wal, fs.ErrNotExist) && errors.Is(journal, fs.ErrNotExist) {
			return last.receipt, nil
		}
	}
	for i := 1; ; i++ {
		candidate := name
		if i > 1 {
			candidate = strings.TrimSuffix(name, ".khr") + " (" + strconv.Itoa(i) + ").khr"
		}
		// Publishing is atomic and fails if any file already occupies the name.
		err := publishNew(dir, target, temp, candidate)
		if err != nil {
			if errors.Is(err, fs.ErrExist) {
				continue
			}
			if _, occupied := dir.Lstat(candidate); occupied == nil {
				continue
			}
			return receipt{}, err
		}
		out := receipt{Name: candidate, Path: filepath.Join(target.dir, candidate)}
		if info, err := dir.Lstat(candidate); err == nil {
			app.saved[key] = savedFile{out, info}
		}
		return out, nil
	}
}

// Preserve root identity on filesystems which use the Windows path-based move.
func unchangedDirectory(target resolvedRoot) error {
	info, err := os.Stat(target.dir)
	if err != nil {
		return err
	}
	if !os.SameFile(target.info, info) {
		return fmt.Errorf("destination changed")
	}
	return nil
}
