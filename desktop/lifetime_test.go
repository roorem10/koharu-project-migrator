package main

import (
	"testing"
	"time"
)

func TestWindowLifetime(t *testing.T) {
	const startup = 90 * time.Second
	const grace = 4 * time.Second
	now := time.Now()
	life := windowLifetime{idleSince: now}
	if life.expire(now.Add(grace), startup, grace) {
		t.Fatal("browser must have time to launch")
	}
	unopened := windowLifetime{idleSince: now}
	if !unopened.expire(now.Add(startup), startup, grace) {
		t.Fatal("abandoned launches must exit")
	}
	life.enter(true) // tab A
	life.enter(true) // tab B
	life.leave()
	if life.expire(now.Add(time.Hour), startup, grace) {
		t.Fatal("the second tab is still open")
	}
	life.leave()
	if life.expire(life.idleSince.Add(grace/2), startup, grace) || !life.enter(true) {
		t.Fatal("a refreshing tab must reconnect")
	}
	life.enter(false) // in-flight save
	life.leave()      // last tab closes
	if life.expire(now.Add(time.Hour), startup, grace) {
		t.Fatal("interrupted an active request")
	}
	life.leave()
	if !life.expire(life.idleSince.Add(grace), startup, grace) || life.enter(true) {
		t.Fatal("must stop after closing the last tab and completing the save")
	}
}
