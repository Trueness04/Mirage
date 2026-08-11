# Generate simple PNG icons (16, 48, 128) for the extension
import struct, zlib, os

def make_png(path, size, color=(16,185,129), bg=(11,15,23)):
    rows = []
    for y in range(size):
        row = b'\x00'
        for x in range(size):
            cx = cy = size / 2
            r = size * 0.42
            in_circle = ((x-cx+0.5)**2 + (y-cy+0.5)**2) <= r*r
            if in_circle:
                row += bytes(color) + b'\xff'
            else:
                row += bytes(bg) + b'\xff'
        rows.append(row)
    raw = b''.join(rows)
    def chunk(typ, data):
        c = typ + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

base = '/home/z/my-project/public/extension/icons'
os.makedirs(base, exist_ok=True)
for s in (16, 48, 128):
    make_png(f'{base}/icon-{s}.png', s)
print("done")
