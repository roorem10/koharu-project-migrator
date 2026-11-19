package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

type projectRow struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
	ID   string `json:"id,omitempty"`
}

type scanResult struct {
	Root    string          `json:"root"`
	Rows    []projectRow    `json:"rows"`
	Skipped int             `json:"skipped"`
	Current []currentFolder `json:"currentFolders"`
}

type currentFolder struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Label   string `json:"label"`
	Running bool   `json:"running"`
}

// Document roots are recursive. The new Koharu library lists only direct .khr children.
type scanRoot struct {
	dir       string
	documents bool
	running   bool
	label     string
}
type projectSource struct{ root, relative string }
type catalog struct {
	locations    func() []scanRoot
	mu           sync.RWMutex
	projects     map[string]projectSource
	destinations map[string]resolvedRoot
}
type resolvedRoot struct {
	dir, canonical, label         string
	info                          fs.FileInfo
	documents, installed, running bool
}

// Check both configured locations and conventional folders. Older projects may
// still be in OneDrive after Windows switches its known Documents folder back.
func documentRoots(documents, oneDriveDocuments, profile string, cloudBases ...string) []scanRoot {
	var roots []scanRoot
	add := func(dir, label string) {
		if filepath.IsAbs(dir) {
			roots = append(roots, scanRoot{dir: dir, documents: true, label: label})
		}
	}
	add(documents, "")
	add(oneDriveDocuments, "OneDrive Documents")
	if profile != "" {
		add(filepath.Join(profile, "Documents"), "")
		add(filepath.Join(profile, "OneDrive", "Documents"), "OneDrive Documents")
	}
	for _, base := range cloudBases {
		if base != "" {
			add(filepath.Join(base, "Documents"), "OneDrive Documents")
		}
	}
	return roots
}

func resolveRoots(candidates []scanRoot) ([]resolvedRoot, int) {
	var roots []resolvedRoot
	skipped := 0
	for _, candidate := range candidates {
		if !filepath.IsAbs(candidate.dir) {
			continue
		}
		name := filepath.Clean(candidate.dir)
		info, err := os.Stat(name)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				skipped++
			}
			continue
		}
		if !info.IsDir() {
			continue
		}
		found := -1
		for i, root := range roots {
			if name == root.dir || os.SameFile(info, root.info) {
				found = i
				break
			}
		}
		if found < 0 {
			canonical, err := filepath.EvalSymlinks(name)
			if err != nil {
				canonical = name
			}
			found = len(roots)
			roots = append(roots, resolvedRoot{dir: name, canonical: canonical, info: info})
		}
		root := &roots[found]
		root.documents = root.documents || candidate.documents
		root.installed = root.installed || !candidate.documents
		root.running = root.running || candidate.running
		if root.label == "" {
			root.label = candidate.label
		}
	}
	// Display only a friendly root and the relative chapter location. Keep the
	// actual destination available locally for the explicit Copy folder path action.
	counts := make(map[string]int)
	for i := range roots {
		root := &roots[i]
		if root.label == "" {
			root.label = "Documents"
			if root.installed {
				root.label = "Koharu projects"
			}
		}
		counts[root.label]++
		if n := counts[root.label]; n > 1 {
			root.label += " (" + strconv.Itoa(n) + ")"
		}
	}
	return roots, skipped
}

func (c *catalog) scan(ctx context.Context) (scanResult, error) {
	result := scanResult{Root: "Projects on this PC", Rows: []projectRow{}, Current: []currentFolder{}}
	roots, skipped := resolveRoots(c.locations())
	result.Skipped = skipped
	projects := make(map[string]projectSource)
	destinations := make(map[string]resolvedRoot)
	// Prune explicit sub-roots from a broader Documents walk. Each location
	// then uses its own scan rules, even for an installation within Documents.
	anchors := make(map[string]bool)
	for _, root := range roots {
		anchors[root.canonical] = true
	}
	readable := 0
	for _, root := range roots {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		err := fs.WalkDir(os.DirFS(root.dir), ".", func(relative string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if walkErr != nil {
				if relative == "." {
					return walkErr
				}
				result.Skipped++
				return nil
			}
			if relative == "." {
				return nil
			}
			if entry.Type()&fs.ModeSymlink != 0 {
				result.Skipped++
				return nil
			}
			local := filepath.FromSlash(relative)
			absolute := filepath.Join(root.dir, local)
			key := filepath.Join(root.canonical, local)
			lower := strings.ToLower(entry.Name())
			if entry.IsDir() {
				if !root.documents || anchors[key] {
					return fs.SkipDir
				}
				if !strings.HasSuffix(lower, ".khrproj") {
					return nil
				}
				hash := sha256.Sum256([]byte(key))
				id := hex.EncodeToString(hash[:])
				projects[id] = projectSource{root: root.dir, relative: local}
				result.Rows = append(result.Rows, projectRow{path.Join(root.label, relative), "legacy", id})
				return fs.SkipDir
			}
			isSlot := lower == "state-a.khr" || lower == "state-b.khr"
			atLibraryTop := root.installed && !strings.Contains(relative, "/")
			if strings.HasSuffix(lower, ".khr") && (!isSlot || atLibraryTop) && isDataFile(absolute, entry.Type()) {
				result.Rows = append(result.Rows, projectRow{Path: path.Join(root.label, relative), Kind: "current"})
			}
			return nil
		})
		if err != nil {
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			result.Skipped++
			continue
		}
		readable++
		if root.installed {
			digest := sha256.Sum256([]byte("output/" + root.canonical))
			id := hex.EncodeToString(digest[:])
			destinations[id] = root
			result.Current = append(result.Current, currentFolder{ID: id, Path: root.dir, Label: root.label, Running: root.running})
		}
	}
	if readable == 0 {
		return result, fs.ErrNotExist
	}
	c.mu.Lock()
	c.projects = projects
	c.destinations = destinations
	c.mu.Unlock()
	return result, nil
}

func validHash(hash string) bool {
	if len(hash) != 64 {
		return false
	}
	for _, c := range hash {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Only the two save slots and explicitly named, content-addressed image blobs
// have routes. Each platform confines reads to the discovered project.
func (c *catalog) open(parts []string) (*os.File, int64, error) {
	if len(parts) != 3 && len(parts) != 4 {
		return nil, 0, fs.ErrNotExist
	}
	c.mu.RLock()
	project, ok := c.projects[parts[1]]
	c.mu.RUnlock()
	if !ok {
		return nil, 0, fs.ErrNotExist
	}
	var relative string
	switch {
	case len(parts) == 3 && (parts[2] == "state-a.khr" || parts[2] == "state-b.khr"):
		relative = parts[2]
	case len(parts) == 4 && parts[2] == "blob" && validHash(parts[3]):
		relative = filepath.FromSlash(path.Join("blobs", parts[3][:2], parts[3]))
	default:
		return nil, 0, fs.ErrNotExist
	}
	return openProjectFile(project.root, project.relative, relative)
}

func fileError(err error) int {
	if errors.Is(err, fs.ErrNotExist) {
		return 404
	}
	return 403
}
