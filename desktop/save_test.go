package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestSaveCompletionAndCollisions(t *testing.T) {
	dir := t.TempDir()
	app := newApp("127.0.0.1:45555", func() []scanRoot { return []scanRoot{{dir: dir}} })
	scan, err := app.catalog.scan(t.Context())
	if err != nil || len(scan.Current) != 1 {
		t.Fatal(scan, err)
	}
	output := scan.Current[0].ID
	data := make([]byte, 16384)
	copy(data, []byte("SQLite format 3\x00"))
	binary.BigEndian.PutUint16(data[16:], 16384)
	binary.BigEndian.PutUint32(data[28:], 1)
	copy(data[68:], "KHRU")
	send := func(name, id string, buf []byte) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "http://"+app.authority+app.prefix+"save/"+id, bytes.NewReader(buf))
		request.Header.Set("Origin", "http://"+app.authority)
		request.Header.Set("Content-Type", "application/octet-stream")
		request.Header.Set("X-Koharu-Name", url.PathEscape(name))
		request.Header.Set("X-Koharu-Save", "1")
		w := httptest.NewRecorder()
		app.ServeHTTP(w, request)
		return w
	}
	for _, test := range []struct {
		name, id string
		data     []byte
	}{
		{"Chapter.khr", output, data[:200]}, {"Chapter.khr", output, []byte("incomplete")}, {"subfolder/Chapter.khr", output, data}, {"Chapter.khr", "absent", data},
	} {
		if r := send(test.name, test.id, test.data); r.Code == 200 {
			t.Fatal("Unexpected save")
		}
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatal("Partial save was exposed")
	}
	var group sync.WaitGroup
	receipts := make(chan receipt, 2)
	for n := 0; n < 2; n++ {
		group.Add(1)
		go func(marker byte) {
			defer group.Done()
			b := bytes.Clone(data)
			b[102] = marker
			w := send("章 (migrated).khr", output, b)
			if w.Code != 200 {
				t.Error(w.Code, w.Body.String())
				return
			}
			var out receipt
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Error(err)
				return
			}
			receipts <- out
		}(byte(n))
	}
	group.Wait()
	close(receipts)
	names := map[string]bool{}
	for out := range receipts {
		names[out.Name] = true
		if filepath.Dir(out.Path) != dir {
			t.Fatal(out.Path)
		}
	}
	if !names["章 (migrated).khr"] || !names["章 (migrated) (2).khr"] {
		t.Fatal(names)
	}
	w := send("章 (migrated).khr", output, data)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	files, _ = os.ReadDir(dir)
	if len(files) != 2 {
		t.Fatal("duplicate retry or abandoned temporary file")
	}
}
func TestRedirectedDocumentsOnce(t *testing.T) {
	profile := t.TempDir()
	cloud := filepath.Join(profile, "OneDrive", "Documents")
	chapter := filepath.Join(cloud, "Koharu", "Chapter.khrproj")
	if err := os.MkdirAll(chapter, 0700); err != nil {
		t.Fatal(err)
	}
	c := catalog{locations: func() []scanRoot { return documentRoots(cloud, cloud, profile, filepath.Dir(cloud)) }}
	r, err := c.scan(t.Context())
	if err != nil || len(r.Rows) != 1 {
		t.Fatal(r, err)
	}
}
