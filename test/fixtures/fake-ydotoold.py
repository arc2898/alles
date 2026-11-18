#!/usr/bin/env python3
"""Stand-in for ydotoold, used by the tests.

Speaks the REAL wire format (one `struct input_event` per datagram, exactly as the client's
uinput_emit() writes it in Client/ydotool.c) and logs each event as "<type> <code> <value>".
It creates no input device, so it needs no /dev/uinput and no root - which is what lets the
real ydotool CLIENT be tested anywhere.

usage: fake-ydotoold.py <socket-path> <log-file>
"""
import atexit, os, signal, socket, struct, sys

path, logfile = sys.argv[1], sys.argv[2]
SIZE = struct.calcsize('llHHi')          # timeval(2 longs) + u16 type + u16 code + s32 value, native layout

def cleanup():
    try: os.unlink(path)
    except OSError: pass

atexit.register(cleanup)
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, lambda *_: sys.exit(0))       # exit normally so atexit removes the socket

cleanup()                                             # a stale socket from a killed run must not survive
sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
sock.bind(path)
os.chmod(path, 0o600)
log = open(logfile, 'a', buffering=1)                # O_APPEND: the test may truncate the file between cases
print('READY', file=log)

while True:
    data = sock.recv(4096)
    if len(data) != SIZE:
        print('BADLEN %d' % len(data), file=log)
        continue
    _, _, etype, code, value = struct.unpack('llHHi', data)
    print('%d %d %d' % (etype, code, value), file=log)
