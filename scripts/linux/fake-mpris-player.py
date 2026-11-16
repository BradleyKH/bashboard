#!/usr/bin/env python3
"""A fake MPRIS media player, for checking Bashboard's Linux Media worker without a real player.

It owns org.mpris.MediaPlayer2.fakeplayer on the D-Bus session bus and serves
/org/mpris/MediaPlayer2 with the org.mpris.MediaPlayer2 and org.mpris.MediaPlayer2.Player
interfaces plus org.freedesktop.DBus.Properties (Get, GetAll, Set, PropertiesChanged).

Behavior a test can rely on:
  - Three tracks, "Fake Track 1" through "Fake Track 3". Next and Previous change the title,
    artist, track id, length, and art URL (each track has its own small PNG in /tmp,
    /tmp/fake-mpris-art-<n>.png), reset the position to zero, and emit PropertiesChanged.
    Both wrap around at the ends.
  - Volume, Shuffle, and LoopStatus are writable through Properties.Set and emit
    PropertiesChanged. PlayPause, Play, and Pause change PlaybackStatus and emit it too.
  - Position advances in real time while playing. Seek and SetPosition emit Seeked.
  - Every method call and property Set is printed to stdout, flushed, one per line:
        call <Method> [args...]        e.g. "call PlayPause", "call Seek 5000000",
                                       "call SetPosition /org/fakeplayer/track/2 12000000"
        set <Property> <value>         e.g. "set Volume 0.5", "set LoopStatus Track"
    The first line printed once the bus name is owned is "ready".

Needs python3-dbus and python3-gi (dbus-python with a GLib main loop). Run it under a session
bus, for example: dbus-run-session -- python3 fake-mpris-player.py
Pass --paused to start in the Paused state instead of Playing.
"""

import struct
import sys
import time
import zlib

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME = "org.mpris.MediaPlayer2.fakeplayer"
OBJECT_PATH = "/org/mpris/MediaPlayer2"
ROOT_IFACE = "org.mpris.MediaPlayer2"
PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
PROPS_IFACE = "org.freedesktop.DBus.Properties"

# (title, artist, album, length in microseconds, art color)
TRACKS = [
    ("Fake Track 1", "Fake Artist", "Fake Album", 180_000_000, (200, 60, 60)),
    ("Fake Track 2", "Fake Artist Two", "Fake Album", 240_000_000, (60, 200, 60)),
    ("Fake Track 3", "Fake Artist", "Other Album", 90_000_000, (60, 60, 200)),
]
ART_SIZE = 64


def art_path(index):
    return "/tmp/fake-mpris-art-%d.png" % index


def write_png(path, color, size=ART_SIZE):
    """Write a small solid-color PNG with a lighter diagonal band, using only the stdlib."""
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filter type none
        for x in range(size):
            lift = 55 if abs(x - y) < size // 8 else 0
            rows.extend(min(255, c + lift) for c in color)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows)))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def log(line):
    print(line, flush=True)


class FakePlayer(dbus.service.Object):
    def __init__(self, bus, paused):
        super().__init__(bus, OBJECT_PATH)
        self.track = 0
        self.status = "Paused" if paused else "Playing"
        self.volume = 0.75
        self.shuffle = False
        self.loop_status = "None"
        # Position is base_us at base_time while playing, frozen at base_us otherwise.
        self.base_us = 0
        self.base_time = time.monotonic()

    # Playback state

    def position_us(self):
        if self.status != "Playing":
            return self.base_us
        elapsed = int((time.monotonic() - self.base_time) * 1_000_000)
        return min(self.base_us + elapsed, TRACKS[self.track][3])

    def set_position(self, us):
        self.base_us = max(0, min(int(us), TRACKS[self.track][3]))
        self.base_time = time.monotonic()
        self.Seeked(dbus.Int64(self.base_us))

    def set_status(self, status):
        if status == self.status:
            return
        self.base_us = self.position_us()
        self.base_time = time.monotonic()
        self.status = status
        self.changed({"PlaybackStatus": self.status})

    def change_track(self, index):
        self.track = index % len(TRACKS)
        self.base_us = 0
        self.base_time = time.monotonic()
        self.changed({"Metadata": self.metadata()})
        self.Seeked(dbus.Int64(0))

    def track_id(self, index=None):
        return "/org/fakeplayer/track/%d" % ((self.track if index is None else index) + 1)

    def metadata(self):
        title, artist, album, length, _ = TRACKS[self.track]
        return dbus.Dictionary(
            {
                "mpris:trackid": dbus.ObjectPath(self.track_id()),
                "mpris:length": dbus.Int64(length),
                "mpris:artUrl": "file://" + art_path(self.track),
                "xesam:title": title,
                "xesam:artist": dbus.Array([artist], signature="s"),
                "xesam:album": album,
            },
            signature="sv",
        )

    # Property tables

    def root_props(self):
        return {
            "CanQuit": dbus.Boolean(False),
            "CanRaise": dbus.Boolean(False),
            "HasTrackList": dbus.Boolean(False),
            "Identity": "Fake Player",
            "SupportedUriSchemes": dbus.Array(["file"], signature="s"),
            "SupportedMimeTypes": dbus.Array(["audio/mpeg"], signature="s"),
        }

    def player_props(self):
        return {
            "PlaybackStatus": self.status,
            "LoopStatus": self.loop_status,
            "Rate": dbus.Double(1.0),
            "MinimumRate": dbus.Double(1.0),
            "MaximumRate": dbus.Double(1.0),
            "Shuffle": dbus.Boolean(self.shuffle),
            "Metadata": self.metadata(),
            "Volume": dbus.Double(self.volume),
            "Position": dbus.Int64(self.position_us()),
            "CanGoNext": dbus.Boolean(True),
            "CanGoPrevious": dbus.Boolean(True),
            "CanPlay": dbus.Boolean(True),
            "CanPause": dbus.Boolean(True),
            "CanSeek": dbus.Boolean(True),
            "CanControl": dbus.Boolean(True),
        }

    def props_for(self, interface):
        if interface == ROOT_IFACE:
            return self.root_props()
        if interface == PLAYER_IFACE:
            return self.player_props()
        raise dbus.exceptions.DBusException(
            "Unknown interface " + interface, name="org.freedesktop.DBus.Error.UnknownInterface"
        )

    def changed(self, props):
        self.PropertiesChanged(PLAYER_IFACE, dbus.Dictionary(props, signature="sv"), dbus.Array([], signature="s"))

    # org.freedesktop.DBus.Properties

    @dbus.service.method(PROPS_IFACE, in_signature="ss", out_signature="v")
    def Get(self, interface, name):
        props = self.props_for(interface)
        if name not in props:
            raise dbus.exceptions.DBusException(
                "Unknown property " + name, name="org.freedesktop.DBus.Error.UnknownProperty"
            )
        return props[name]

    @dbus.service.method(PROPS_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return dbus.Dictionary(self.props_for(interface), signature="sv")

    @dbus.service.method(PROPS_IFACE, in_signature="ssv")
    def Set(self, interface, name, value):
        if interface != PLAYER_IFACE:
            raise dbus.exceptions.DBusException(
                "Property is read-only", name="org.freedesktop.DBus.Error.PropertyReadOnly"
            )
        if name == "Volume":
            self.volume = max(0.0, float(value))
            log("set Volume %s" % self.volume)
            self.changed({"Volume": dbus.Double(self.volume)})
        elif name == "Shuffle":
            self.shuffle = bool(value)
            log("set Shuffle %s" % str(self.shuffle).lower())
            self.changed({"Shuffle": dbus.Boolean(self.shuffle)})
        elif name == "LoopStatus":
            if str(value) not in ("None", "Track", "Playlist"):
                raise dbus.exceptions.DBusException(
                    "Invalid LoopStatus", name="org.freedesktop.DBus.Error.InvalidArgs"
                )
            self.loop_status = str(value)
            log("set LoopStatus %s" % self.loop_status)
            self.changed({"LoopStatus": self.loop_status})
        else:
            raise dbus.exceptions.DBusException(
                "Property is read-only or unknown: " + name, name="org.freedesktop.DBus.Error.PropertyReadOnly"
            )

    @dbus.service.signal(PROPS_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    # org.mpris.MediaPlayer2

    @dbus.service.method(ROOT_IFACE)
    def Raise(self):
        log("call Raise")

    @dbus.service.method(ROOT_IFACE)
    def Quit(self):
        log("call Quit")

    # org.mpris.MediaPlayer2.Player

    @dbus.service.method(PLAYER_IFACE)
    def PlayPause(self):
        log("call PlayPause")
        self.set_status("Paused" if self.status == "Playing" else "Playing")

    @dbus.service.method(PLAYER_IFACE)
    def Play(self):
        log("call Play")
        self.set_status("Playing")

    @dbus.service.method(PLAYER_IFACE)
    def Pause(self):
        log("call Pause")
        self.set_status("Paused")

    @dbus.service.method(PLAYER_IFACE)
    def Stop(self):
        log("call Stop")
        self.set_status("Stopped")

    @dbus.service.method(PLAYER_IFACE)
    def Next(self):
        log("call Next")
        self.change_track(self.track + 1)

    @dbus.service.method(PLAYER_IFACE)
    def Previous(self):
        log("call Previous")
        self.change_track(self.track - 1)

    @dbus.service.method(PLAYER_IFACE, in_signature="x")
    def Seek(self, offset):
        log("call Seek %d" % offset)
        self.set_position(self.position_us() + int(offset))

    @dbus.service.method(PLAYER_IFACE, in_signature="ox")
    def SetPosition(self, track_id, position):
        log("call SetPosition %s %d" % (track_id, position))
        if str(track_id) != self.track_id():
            return  # per the MPRIS spec, a stale track id is ignored
        self.set_position(position)

    @dbus.service.signal(PLAYER_IFACE, signature="x")
    def Seeked(self, position):
        pass


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    for i, track in enumerate(TRACKS):
        write_png(art_path(i), track[4])
    bus = dbus.SessionBus()
    name = dbus.service.BusName(BUS_NAME, bus, do_not_queue=True)
    player = FakePlayer(bus, paused="--paused" in sys.argv[1:])
    log("ready")
    try:
        GLib.MainLoop().run()
    except KeyboardInterrupt:
        pass
    del player, name


if __name__ == "__main__":
    main()
