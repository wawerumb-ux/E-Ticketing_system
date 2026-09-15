"""Minimal pure-Python QR Code encoder (byte mode, ECC level M, versions 1-10).

Produces the module matrix and standalone SVG for small text payloads (URLs,
links, short strings). No third-party dependencies: Galois-field tables are
computed from the standard generator polynomial 0x11D, and RS block/alignment
/format constants are the ISO/IEC 18004 tables.

Correctness is verified module-for-module against the reference Python
``qrcode`` package (see backend/tests or the task report).
"""

_ERR_EC_BITS = {'L': 1, 'M': 0, 'Q': 3, 'H': 2}

# (num_blocks1, total1, data1 [, num_blocks2, total2, data2]) per version,
# ECC level M (offset 1 in the RS block table). Whitelist: versions 1-10.
_RS_BLOCKS_M = {
    1: (1, 26, 16),
    2: (1, 44, 28),
    3: (1, 70, 44),
    4: (2, 50, 32),
    5: (2, 67, 43),
    6: (4, 43, 27),
    7: (4, 49, 31),
    8: (2, 60, 38, 2, 61, 39),
    9: (3, 58, 36, 2, 59, 37),
    10: (4, 69, 43, 1, 70, 44),
}

_ALIGNMENT_POSITIONS = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
}

_G15 = 0x537        # BCH generator for format information
_G15_MASK = 0x5412  # fixed XOR applied to the format bits
_G18 = 0x1F25       # BCH generator for version information
_PAD0 = 0xEC
_PAD1 = 0x11


def _blocks(version):
    """Expand the RS block spec into (data_count, ecc_count) pairs."""
    spec = _RS_BLOCKS_M[version]
    out = []
    for i in range(0, len(spec), 3):
        count, total, data = spec[i:i + 3]
        out.extend([(data, total - data)] * count)
    return out


def _data_capacity_bits(version):
    return 8 * sum(data for data, _ in _blocks(version))


def _build_gf():
    """exp/log tables for GF(256) with generator polynomial 0x11D."""
    exp = [0] * 256
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    return exp, log


_EXP, _LOG = _build_gf()


def _gmul(a, b):
    if a == 0 or b == 0:
        return 0
    return _EXP[(_LOG[a] + _LOG[b]) % 255]


def _generator_poly(ecc):
    """Generator polynomial product_{i=0..ecc-1} (x + alpha^i)."""
    gen = [1]
    for i in range(ecc):
        factor = _EXP[i % 255]
        nxt = [0] * (len(gen) + 1)
        for j, coef in enumerate(gen):
            nxt[j] ^= coef
            nxt[j + 1] ^= _gmul(coef, factor)
        gen = nxt
    return gen


def _rs_remainder(data, ecc):
    """ECC codewords for a data block: (data*x^ecc) mod generator poly."""
    gen = _generator_poly(ecc)
    buf = list(data) + [0] * ecc
    for pos in range(len(data)):
        coef = buf[pos]
        if coef:
            for j, g in enumerate(gen):
                buf[pos + j] ^= _gmul(coef, g)
    return buf[len(data):]


def _bitstream(data, version):
    """Build the padded data codeword list (always byte mode)."""
    count_bits = 8 if version < 10 else 16
    capacity = _data_capacity_bits(version)

    bits = []

    def put(value, n):
        for shift in range(n - 1, -1, -1):
            bits.append((value >> shift) & 1)

    put(0b0100, 4)  # byte mode indicator
    put(len(data), count_bits)
    for byte in data:
        put(byte, 8)

    if len(bits) > capacity:
        raise ValueError(
            f"data too long for version {version}: {len(bits)} > {capacity} bits"
        )

    put(0, min(4, capacity - len(bits)))
    while len(bits) % 8:
        bits.append(0)
    while len(bits) < capacity:
        put(_PAD0, 8)
        if len(bits) < capacity:
            put(_PAD1, 8)

    out = []
    for i in range(0, len(bits), 8):
        byte = 0
        for b in bits[i:i + 8]:
            byte = (byte << 1) | b
        out.append(byte)
    return out


def _interleave(data_codewords, version):
    """Split into blocks, append ECC, then interleave data and ECC."""
    blocks = _blocks(version)
    if sum(data for data, _ in blocks) != len(data_codewords):
        raise ValueError("codeword length mismatch")

    dcs = []
    ecs = []
    offset = 0
    for data_count, ecc_count in blocks:
        dc = data_codewords[offset:offset + data_count]
        offset += data_count
        dcs.append(dc)
        ecs.append(_rs_remainder(dc, ecc_count))

    out = []
    for i in range(max(len(dc) for dc in dcs)):
        for dc in dcs:
            if i < len(dc):
                out.append(dc[i])
    for i in range(max(len(ec) for ec in ecs)):
        for ec in ecs:
            if i < len(ec):
                out.append(ec[i])
    return out


def _bch_remainder(value, generator, digits):
    while _bits(value) - _bits(generator) >= 0:
        value ^= generator << (_bits(value) - _bits(generator))
    return value


def _bits(value):
    n = 0
    while value:
        n += 1
        value >>= 1
    return n


def _format_bits(mask, ec_level='M'):
    data = (_ERR_EC_BITS[ec_level] << 3) | mask
    return ((data << 10) | _bch_remainder(data << 10, _G15, 15)) ^ _G15_MASK


def _version_bits(version):
    return (version << 12) | _bch_remainder(version << 12, _G18, 18)


def _mask_func(pattern):
    def f(i, j):
        if pattern == 0:
            return (i + j) % 2 == 0
        if pattern == 1:
            return i % 2 == 0
        if pattern == 2:
            return j % 3 == 0
        if pattern == 3:
            return (i + j) % 3 == 0
        if pattern == 4:
            return (i // 2 + j // 3) % 2 == 0
        if pattern == 5:
            return (i * j) % 2 + (i * j) % 3 == 0
        if pattern == 6:
            return ((i * j) % 2 + (i * j) % 3) % 2 == 0
        return ((i * j) % 3 + (i + j) % 2) % 2 == 0
    return f


def _matrix(codewords, version, mask):
    n = version * 4 + 17
    m = [[None] * n for _ in range(n)]

    def probe(r0, c0):
        for r in range(-1, 8):
            rr = r0 + r
            if not 0 <= rr < n:
                continue
            for c in range(-1, 8):
                cc = c0 + c
                if not 0 <= cc < n:
                    continue
                m[rr][cc] = (
                    (0 <= r <= 6 and c in (0, 6))
                    or (0 <= c <= 6 and r in (0, 6))
                    or (2 <= r <= 4 and 2 <= c <= 4)
                )

    probe(0, 0)
    probe(n - 7, 0)
    probe(0, n - 7)

    positions = _ALIGNMENT_POSITIONS[version]
    for rp in positions:
        for cp in positions:
            if m[rp][cp] is not None:
                continue
            for r in range(-2, 3):
                for c in range(-2, 3):
                    m[rp + r][cp + c] = (
                        r in (-2, 2) or c in (-2, 2) or (r == 0 and c == 0)
                    )

    for i in range(8, n - 8):
        if m[i][6] is None:
            m[i][6] = i % 2 == 0
        if m[6][i] is None:
            m[6][i] = i % 2 == 0

    fmt = _format_bits(mask)
    for i in range(15):
        bit = (fmt >> i) & 1
        if i < 6:
            m[i][8] = bit
        elif i < 8:
            m[i + 1][8] = bit
        else:
            m[n - 15 + i][8] = bit
    for i in range(15):
        bit = (fmt >> i) & 1
        if i < 8:
            m[8][n - 1 - i] = bit
        elif i < 9:
            m[8][7] = bit
        else:
            m[8][15 - i - 1] = bit
    m[n - 8][8] = True

    if version >= 7:
        vi = _version_bits(version)
        for i in range(18):
            bit = (vi >> i) & 1
            m[i // 3][i % 3 + n - 11] = bit
            m[i % 3 + n - 11][i // 3] = bit

    mask_f = _mask_func(mask)
    row = n - 1
    inc = -1
    bit_index = 7
    byte_index = 0
    for col in range(n - 1, 0, -2):
        if col <= 6:
            col -= 1
        col_pair = (col, col - 1)
        while True:
            for c in col_pair:
                if m[row][c] is None:
                    dark = False
                    if byte_index < len(codewords):
                        dark = bool((codewords[byte_index] >> bit_index) & 1)
                    if mask_f(row, c):
                        dark = not dark
                    m[row][c] = dark
                    bit_index -= 1
                    if bit_index == -1:
                        byte_index += 1
                        bit_index = 7
            row += inc
            if not 0 <= row < n:
                row -= inc
                inc = -inc
                break

    return [[bool(cell) for cell in row] for row in m]


def _penalty(matrix):
    n = len(matrix)
    score = 0

    which = [0] * (n + 1)

    def scan_line(line):
        prev = line[0]
        length = 1
        for val in line[1:]:
            if val == prev:
                length += 1
            else:
                if length >= 5:
                    which[length] += 1
                length = 1
                prev = val
        if length >= 5:
            which[length] += 1

    for row in matrix:
        scan_line(row)
    for c in range(n):
        scan_line([matrix[r][c] for r in range(n)])
    score += sum(which[length] * (length - 2) for length in range(5, n + 1))

    for r in range(n - 1):
        for c in range(n - 1):
            if matrix[r][c] == matrix[r][c + 1] == matrix[r + 1][c] == matrix[r + 1][c + 1]:
                score += 3

    def pattern_scan(seq):
        nonlocal score
        for start in range(n - 10):
            seg = seq[start:start + 11]
            if (
                seg == [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
                or seg == [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
            ):
                score += 40

    for row in matrix:
        pattern_scan(row)
    for c in range(n):
        pattern_scan([matrix[r][c] for r in range(n)])

    dark = sum(sum(row) for row in matrix)
    percent = dark / (n * n) * 100
    score += int(abs(percent - 50) / 5) * 10
    return score


def qr_matrix(data, version=None, mask=None, ec_level='M'):
    """Return the QR module matrix as a list of bool rows (True = dark).

    ``data`` is bytes (or str, encoded UTF-8) in byte mode. ``version`` and
    ``mask`` default to the smallest version and the best mask.
    """
    if isinstance(data, str):
        data = data.encode('utf-8')
    data = bytes(data)

    if version is None:
        count_bits_base = 8
        needed = 4 + count_bits_base + 8 * len(data)
        version = None
        for v in range(1, 11):
            if needed <= _data_capacity_bits(v):
                version = v
                break
        if version is None:
            raise ValueError(f"data too long: {len(data)} bytes (max for v10-M)")

    codewords = _interleave(_bitstream(data, version), version)

    if mask is None:
        best = 0
        best_score = None
        for p in range(8):
            m = _matrix(codewords, version, p)
            s = _penalty(m)
            if best_score is None or s < best_score:
                best = p
                best_score = s
        mask = best

    return _matrix(codewords, version, mask)


def _xml_escape(text):
    return (
        text.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
        .replace("'", '&#39;')
    )


def qr_svg(data, scale=8, quiet=4, dark='#111827', light='#ffffff'):
    """Standalone SVG (inline, no external resources) for a QR code."""
    matrix = qr_matrix(data)
    size = len(matrix)
    cell = scale
    dim = (size + 2 * quiet) * cell
    parts = []
    for r, row in enumerate(matrix):
        for c, on in enumerate(row):
            if on:
                x = (c + quiet) * cell
                y = (r + quiet) * cell
                parts.append(f"M{x} {y}h{cell}v{cell}h-{cell}z")
    path = ' '.join(parts)
    if isinstance(data, bytes):
        data_aria = _xml_escape(data.decode('utf-8', 'replace'))
    else:
        data_aria = _xml_escape(data)
    dark_esc = _xml_escape(dark)
    light_esc = _xml_escape(light)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dim} {dim}" '
        f'width="{dim}" height="{dim}" role="img" '
        f'aria-label="QR code for {data_aria}">'
        f'<rect width="{dim}" height="{dim}" fill="{light_esc}"/>'
        f'<path d="{path}" fill="{dark_esc}"/>'
        f'</svg>'
    )