package main

import (
	"testing"
)

func TestBuildEffectiveRoom(t *testing.T) {
	tests := []struct {
		mode     string
		passcode string
		want     string
	}{
		{"chat", "room1", "room1"},
		{"chat", "", ""},
		{"GroupDiscussion", "room1", "GroupDiscussion|room1"},
		{"GroupDiscussion", "GroupDiscussion|room1", "GroupDiscussion|room1"},
		{"interview", "room2", "interview|room2"},
		{"interview", "interview|room2", "interview|room2"},
		{"interview", "", "interview|"}, 
	}

	for _, tt := range tests {
		if got := buildEffectiveRoom(tt.mode, tt.passcode); got != tt.want {
			t.Errorf("buildEffectiveRoom(%q, %q) = %q, want %q", tt.mode, tt.passcode, got, tt.want)
		}
	}
}

func TestSplitEffectiveRoom(t *testing.T) {
	tests := []struct {
		passcode string
		wantMode string
		wantRaw  string
	}{
		{"GroupDiscussion|room1", "GroupDiscussion", "room1"},
		{"interview|room2", "interview", "room2"},
		{"room3", "chat", "room3"},
		{"", "chat", ""},
	}

	for _, tt := range tests {
		gotMode, gotRaw := splitEffectiveRoom(tt.passcode)
		if gotMode != tt.wantMode || gotRaw != tt.wantRaw {
			t.Errorf("splitEffectiveRoom(%q) = (%q, %q), want (%q, %q)", tt.passcode, gotMode, gotRaw, tt.wantMode, tt.wantRaw)
		}
	}
}

func TestHub_IsUsernameTaken(t *testing.T) {
	h := newHub()
	h.usernames["alice"] = &Client{username: "alice"}
	h.offlineUsers["bob"] = &offlineUser{Username: "bob"}

	if !h.IsUsernameTaken("alice") {
		t.Error("IsUsernameTaken(alice) should be true")
	}
	if !h.IsUsernameTaken("bob") {
		t.Error("IsUsernameTaken(bob) should be true")
	}
	if h.IsUsernameTaken("charlie") {
		t.Error("IsUsernameTaken(charlie) should be false")
	}
}
