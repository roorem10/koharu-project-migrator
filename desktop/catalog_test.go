package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIndexAndFileRoutes(t *testing.T) {
	doc := t.TempDir()
	for _, name := range []string{"Library/Chapter 02.khrproj/state-a.khr", "Backups/Chapter 02.khrproj/state-b.khr", "Current.khr", "state-a.khr", "Library/Chapter 02.khrproj/inner.khr", "readme.txt"} {
		absolute := filepath.Join(doc, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	app := newApp("127.0.0.1:8000", func() []scanRoot { return []scanRoot{{dir: doc, documents: true}} })
	call := func(leaf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://"+app.authority+app.prefix+leaf, nil)
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		return w
	}
	ref := call("scan")
	if ref.Code != 200 {
		t.Fatalf("%d %s", ref.Code, ref.Body.String())
	}
	var result scanResult
	if err := json.Unmarshal(ref.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 3 {
		t.Fatalf("wrong index: %+v", result)
	}
	ids := map[string]bool{}
	for _, row := range result.Rows {
		if !strings.HasPrefix(row.Path, "Documents/") || strings.Contains(row.Path, doc) {
			t.Fatal("expected a relative display location", row.Path)
		}
		if row.Kind == "current" {
			continue
		}
		if ids[row.ID] {
			t.Fatal("duplicate IDs")
		}
		ids[row.ID] = true
		service := "project/" + row.ID + "/"
		if strings.HasSuffix(row.Path, "/Library/Chapter 02.khrproj") {
			read := call(service + "state-a.khr")
			if read.Code != 200 || read.Body.String() != "Library/Chapter 02.khrproj/state-a.khr" {
				t.Fatal("missing source bytes")
			}
			if call(service+"state-b.khr").Code != 404 {
				t.Fatal("missing save response")
			}
		}
		if call(service+"readme.txt").Code != 404 {
			t.Fatal("unexpected file route")
		}
	}
	if len(ids) != 2 {
		t.Fatal("did not distinguish duplicate chapter titles")
	}
	if !strings.Contains(call("").Body.String(), `name="koharu-edition" content="windows"`) {
		t.Fatal("wrong embedded startup mode")
	}
	if err := os.RemoveAll(filepath.Join(doc, "Backups")); err != nil {
		t.Fatal(err)
	}
	repeat, err := app.catalog.scan(context.Background())
	if err != nil || len(repeat.Rows) != 2 {
		t.Fatalf("refresh failed: %v %v", repeat, err)
	}
	for _, row := range repeat.Rows {
		if row.Kind == "legacy" && !ids[row.ID] {
			t.Fatal("unstable project ID")
		}
	}
	request := httptest.NewRequest("GET", "http://"+app.authority+app.prefix+"scan", nil)
	request.Header.Set("Origin", "https://example.invalid")
	block := httptest.NewRecorder()
	app.ServeHTTP(block, request)
	if block.Code != 404 {
		t.Fatal("only the local app may read the index")
	}
}
func TestDirectSourceBytes(t *testing.T) {
	dir := t.TempDir()
	hash := strings.Repeat("1a", 32)
	folder := filepath.Join(dir, "Unicode 日本語.khrproj", "blobs", hash[:2])
	if err := os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, hash), []byte{0, 1, 2, 255}, 0600); err != nil {
		t.Fatal(err)
	}
	c := catalog{locations: func() []scanRoot { return []scanRoot{{dir: dir, documents: true}} }}
	result, err := c.scan(context.Background())
	if err != nil || len(result.Rows) != 1 {
		t.Fatal(result, err)
	}
	file, size, err := c.open([]string{"project", result.Rows[0].ID, "blob", hash})
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	b, err := io.ReadAll(file)
	if err != nil || size != 4 || len(b) != 4 || b[3] != 255 {
		t.Fatal("blob changed")
	}
}
