#!/usr/bin/env python3
"""
Pixel art de El Valle: cañas (assets/rods/<id>.png) e insignias de logros (assets/badges/<id>.png).

Todo se dibuja píxel por píxel en una grilla chica (cañas 32×32, insignias 40×40) con paletas
limitadas, sombreado de 2-3 tonos y contorno oscuro de 1 px; después se agranda ×6 sin suavizado.

Uso:
  npx tsx -e "import {DEFAULT_CONFIG as c} from './src/game/defaults'; console.log(JSON.stringify(c.achievements))" > /tmp/ach.json
  python3 scripts/pixel-art.py /tmp/ach.json
Requiere Pillow. Solo hace falta si agregás cañas o logros: las imágenes ya vienen generadas.
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCALE = 6
INK = (20, 16, 32, 255)          # contorno
LINE = (225, 230, 240, 170)      # tanza


def hx(s, a=255):
    s = s.lstrip('#')
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), a)


class Canvas:
    def __init__(self, n):
        self.n = n
        self.px = [[None] * n for _ in range(n)]

    def put(self, x, y, c):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.n and 0 <= y < self.n and c is not None:
            self.px[y][x] = c

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < self.n and 0 <= y < self.n else None

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.put(x, y, c)

    def outline(self, color=INK, skip=None):
        """Contorno de 1 px alrededor de todo lo opaco (salvo colores en `skip`, p. ej. la tanza)."""
        skip = skip or set()
        solid = [[c is not None and c not in skip for c in row] for row in self.px]
        for y in range(self.n):
            for x in range(self.n):
                if self.px[y][x] is not None:
                    continue
                if any(0 <= x + dx < self.n and 0 <= y + dy < self.n and solid[y + dy][x + dx]
                       for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    self.px[y][x] = color

    def image(self, scale=SCALE):
        im = Image.new('RGBA', (self.n, self.n), (0, 0, 0, 0))
        for y in range(self.n):
            for x in range(self.n):
                if self.px[y][x] is not None:
                    im.putpixel((x, y), self.px[y][x])
        return im.resize((self.n * scale, self.n * scale), Image.NEAREST)


def line_pts(x0, y0, x1, y1):
    pts = []
    dx, dy = abs(x1 - x0), -abs(y1 - y0)
    sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
    err = dx + dy
    while True:
        pts.append((x0, y0))
        if x0 == x1 and y0 == y1:
            return pts
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy


# ───────────────────────── Cañas (32×32) ─────────────────────────

# Colores tomados de la ilustración original de cada caña.
RODS = {
    'junco':      dict(shaft=('#a86b35', '#d19556', '#6e4220'), grip=('#7a4a22', '#a0652f', '#4e2d12'), ring='#e0b54a', reel=('#d4a017', '#f5d76e', '#8a6508'), lure='minnow', lc=('#f07a2a', '#ffb070')),
    'corcho':     dict(shaft=('#34343e', '#55556a', '#1e1e26'), grip=('#d9a066', '#f0c898', '#a06a38'), ring='#c9a24a', reel=('#44464f', '#7a7c86', '#26272e'), spool='#8cc63f', lure='frog', lc=('#5aa02c', '#a8e063')),
    'sauce':      dict(shaft=('#2c2c34', '#4c4c58', '#18181e'), grip=('#26262c', '#44444e', '#141418'), ring='#8fdc2e', reel=('#3a3c44', '#6a6c76', '#202128'), spool='#8fdc2e', lure='squid', lc=('#7ed321', '#c3f07a')),
    'tejedora':   dict(shaft=('#30323a', '#5a5e6a', '#1a1b21'), grip=('#2a2b31', '#4a4c55', '#16171b'), ring='#c8d0dc', reel=('#5b6f95', '#9fb3d8', '#34425e'), lure='minnow', lc=('#b8c4d4', '#eef3fa')),
    'boya_roja':  dict(shaft=('#2c2c32', '#4e4e58', '#17171c'), grip=('#26262c', '#44444e', '#141418'), ring='#e02a2a', reel=('#c41e1e', '#ff5a5a', '#7a1010'), lure='bobber', lc=('#e02a2a', '#ffffff')),
    'coral':      dict(shaft=('#2c2c32', '#4e4e58', '#17171c'), grip=('#26262c', '#44444e', '#141418'), ring='#ff7a1a', reel=('#e8650f', '#ffa35c', '#8a3a06'), lure='spoon', lc=('#c8d0dc', '#ffffff')),
    'marea_azul': dict(shaft=('#2a2c34', '#4a4e5c', '#16171d'), grip=('#24262c', '#40434e', '#121318'), ring='#2a7fff', reel=('#1f5fd1', '#5c9bff', '#10336e'), lure='minnow', lc=('#2a7fff', '#bcd8ff')),
    'relampago':  dict(shaft=('#2a2e34', '#48505c', '#15181c'), grip=('#24272c', '#40454e', '#121417'), ring='#19d3c5', reel=('#11a89c', '#5ef0e4', '#085a54'), lure='striped', lc=('#3a8fe0', '#e8f4ff')),
    'camuflaje':  dict(shaft=('#5d6b33', '#8a9a4e', '#35401a'), grip=('#4a5528', '#6f7d3e', '#2a3214'), ring='#9aa85a', reel=('#56613a', '#8a9660', '#30381e'), lure='minnow', lc=('#c8d0dc', '#ffffff'), camo=True, eye='#e02a2a'),
    'brujula':    dict(shaft=('#7b2fd1', '#a865ff', '#4a168a'), grip=('#2c2436', '#4a3e5c', '#17121e'), ring='#c79bff', reel=('#8a3ae0', '#c28cff', '#4c1a86'), lure='minnow', lc=('#b060ff', '#e8ccff')),
    'abismo':     dict(shaft=('#2a1f6e', '#4b3aa8', '#150f3a'), grip=('#1a1530', '#30285a', '#0c0a18'), ring='#8f6bff', reel=('#3b2a9a', '#6d5ae0', '#1c124e'), lure='squid', lc=('#7b5cff', '#c9b8ff'), glow='#8a4dff'),
    'astro':      dict(shaft=('#d9a520', '#ffe070', '#8a6208'), grip=('#2a2418', '#4e4228', '#15110a'), ring='#fff2b0', reel=('#e8b82a', '#fff0a0', '#8a6a10'), lure='star', lc=('#ffd84a', '#ffffff'), sparkle='#fff6c8'),
}


def shade3(c, x, y):
    """Sombreado simple: arriba-izquierda claro, abajo-derecha oscuro."""
    return c


def draw_rod(rid, spec):
    cv = Canvas(32)
    base, hi, sh = [hx(c) for c in spec['shaft']]
    gb, gh, gs = [hx(c) for c in spec['grip']]
    ring = hx(spec['ring'])
    # Caña: diagonal de (5,27) a (25,4). Mango de 3 px, vara de 2 px, puntera de 1 px.
    path = line_pts(5, 27, 25, 4)
    n = len(path)
    for i, (x, y) in enumerate(path):
        t = i / (n - 1)
        if t < 0.30:  # mango
            camo = spec.get('camo') and (x + y) % 3 == 0
            cv.put(x, y, gs if camo else gb)
            cv.put(x - 1, y, gh)
            cv.put(x + 1, y, gs)
            cv.put(x, y + 1, gs)
        elif t < 0.75:
            camo = spec.get('camo') and ((x * 7 + y * 3) % 5 in (0, 1))
            cv.put(x, y, sh if camo else base)
            cv.put(x - 1, y, hi)
        else:
            cv.put(x, y, base)
    # Anillos / guías (acento de color de cada caña)
    for t in (0.30, 0.52, 0.72, 0.88):
        x, y = path[int(t * (n - 1))]
        cv.put(x, y, ring)
        cv.put(x - 1, y, ring)
    # Contera del mango
    x0, y0 = path[0]
    cv.put(x0, y0 + 1, ring)
    cv.put(x0 - 1, y0, ring)
    # Reel (carrete) debajo de la vara, cerca del mango
    rb, rh, rs = [hx(c) for c in spec['reel']]
    rx, ry = 11, 21
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dx * dx + dy * dy <= 5:
                cv.put(rx + dx, ry + dy, rh if dx + dy < -1 else rs if dx + dy > 1 else rb)
    cv.put(rx, ry, hx(spec.get('spool', spec['reel'][1])))
    cv.put(rx + 1, ry, hx(spec.get('spool', spec['reel'][0])))
    # Manivela del reel
    cv.put(rx + 3, ry + 1, rs)
    cv.put(rx + 4, ry + 2, rs)
    cv.put(rx + 4, ry + 3, hx('#1e1e24'))
    # Tanza desde la puntera
    tx, ty = path[-1]
    for y in range(ty + 1, 16):
        cv.put(tx + 1, y, LINE)
    draw_lure(cv, tx + 1, 16, spec)
    # Efectos especiales
    if spec.get('glow'):
        glow(cv, hx(spec['glow'], 150))
    cv.outline(skip={LINE})
    if spec.get('sparkle'):
        s = hx(spec['sparkle'])
        for (x, y) in ((4, 5), (29, 25), (17, 2)):
            for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
                if cv.get(x + dx, y + dy) is None:
                    cv.put(x + dx, y + dy, s)
    return cv


def glow(cv, c):
    """Halo tramado (dithering) alrededor de la silueta."""
    solid = [[p is not None for p in row] for row in cv.px]
    for y in range(cv.n):
        for x in range(cv.n):
            if solid[y][x] or (x + y) % 2:
                continue
            near = any(0 <= x + dx < cv.n and 0 <= y + dy < cv.n and solid[y + dy][x + dx]
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1))
            if near:
                cv.put(x, y, c)


def draw_lure(cv, x, y, spec):
    a, b = hx(spec['lc'][0]), hx(spec['lc'][1])
    kind = spec['lure']
    hook = hx('#9aa0aa')
    if kind in ('minnow', 'striped'):
        for dy in range(0, 6):
            w = 1 if dy in (0, 5) else 2
            for dx in range(-w + 1, w):
                c = b if dx < 0 else a
                if kind == 'striped' and dy % 2 == 1:
                    c = b
                cv.put(x + dx, y + dy, c)
        cv.put(x, y + 1, hx(spec.get('eye', '#141418')))
        cv.put(x + 1, y + 6, hook)
        cv.put(x, y + 7, hook)
        cv.put(x - 1, y + 6, hook)
    elif kind == 'frog':
        for dy in range(0, 4):
            for dx in range(-2, 3):
                if abs(dx) + (dy == 0) < 3:
                    cv.put(x + dx, y + dy, a if (dx + dy) % 3 else b)
        cv.put(x - 1, y, hx('#ffffff'))
        cv.put(x + 1, y, hx('#ffffff'))
        cv.put(x - 2, y + 4, a)
        cv.put(x + 2, y + 4, a)
        cv.put(x, y + 5, hook)
    elif kind == 'bobber':
        for dy in range(0, 5):
            for dx in range(-2, 3):
                if dx * dx + (dy - 2) ** 2 <= 5:
                    cv.put(x + dx, y + dy, a if dy < 2 else b)
        cv.put(x - 1, y + 1, hx('#ff9a9a'))
        cv.put(x, y + 5, hook)
        cv.put(x, y + 6, hook)
        cv.put(x - 1, y + 7, hook)
    elif kind == 'spoon':
        for dy in range(0, 6):
            w = 1 if dy in (0, 5) else 2
            for dx in range(-w + 1, w):
                cv.put(x + dx, y + dy, b if (dx < 0 and dy < 3) else a)
        cv.put(x, y + 6, hook)
        cv.put(x - 1, y + 7, hook)
        cv.put(x + 1, y + 7, hook)
    elif kind == 'squid':
        for dy in range(0, 3):
            for dx in (-1, 0, 1):
                cv.put(x + dx, y + dy, b if dy == 0 else a)
        cv.put(x, y + 1, hx('#141418'))
        for dx in (-2, -1, 0, 1, 2):
            for dy in range(3, 7 if dx % 2 == 0 else 6):
                cv.put(x + dx + (1 if dy > 4 and dx < 0 else 0), y + dy, a)
    elif kind == 'star':
        for (dx, dy) in ((0, 0), (0, 1), (-1, 2), (0, 2), (1, 2), (-2, 2), (2, 2), (0, 3), (-1, 4), (1, 4), (-1, 3), (1, 3)):
            cv.put(x + dx, y + dy, a if dy != 2 or abs(dx) < 2 else b)
        cv.put(x, y + 2, b)
        cv.put(x, y + 5, hook)


# ───────────────────────── Insignias (40×40) ─────────────────────────

TIER = {  # (claro, medio, oscuro), cantidad de marcas
    'bronce': (('#f0b27a', '#cd7f32', '#7a4414'), 1),
    'plata': (('#ffffff', '#c0c7d0', '#6c7686'), 2),
    'oro': (('#fff3a0', '#f1c40f', '#9a6e00'), 3),
    'platino': (('#e8ffff', '#7fdbda', '#2f8a8c'), 4),
    'diamante': (('#f4e8ff', '#b388ff', '#5a2ea8'), 5),
}
CAT = {
    'pesca': ('#3a8fd9', '#1f5a9e', '#123763'),
    'granja': ('#5cbf4f', '#347a2c', '#1d4a18'),
    'economia': ('#e0a93a', '#a8741a', '#62410a'),
    'progresion': ('#9a6ad9', '#62389e', '#3a1f63'),
    'canas': ('#2ec4b6', '#17807a', '#0b4a47'),
    'eventos': ('#e0588a', '#a42e5c', '#5e1633'),
}


def shape_mask(tier, n, r):
    """Máscara booleana nítida (sin antialias) de la forma del marco."""
    im = Image.new('1', (n, n), 0)
    d = ImageDraw.Draw(im)
    c = (n - 1) / 2
    if tier == 'bronce':
        d.ellipse([c - r, c - r, c + r, c + r], fill=1)
    elif tier == 'plata':
        w = r * 0.9
        d.polygon([(c - w, c - r * 0.8), (c - w * 0.5, c - r), (c + w * 0.5, c - r), (c + w, c - r * 0.8), (c + w, c + r * 0.1),
                   (c + w * 0.5, c + r * 0.7), (c, c + r), (c - w * 0.5, c + r * 0.7), (c - w, c + r * 0.1)], fill=1)
    elif tier == 'oro':
        d.polygon([(c + r * math.cos(math.radians(a)), c + r * math.sin(math.radians(a))) for a in range(-90, 270, 60)], fill=1)
    elif tier == 'platino':
        pts = []
        for i in range(16):
            rr = r if i % 2 == 0 else r * 0.8
            a = math.radians(-90 + i * 22.5)
            pts.append((c + rr * math.cos(a), c + rr * math.sin(a)))
        d.polygon(pts, fill=1)
    else:
        d.polygon([(c, c - r), (c + r * 0.85, c), (c, c + r), (c - r * 0.85, c)], fill=1)
    return [[bool(im.getpixel((x, y))) for x in range(n)] for y in range(n)]


def erode(mask, k=1):
    n = len(mask)
    out = [row[:] for row in mask]
    for _ in range(k):
        prev = [row[:] for row in out]
        for y in range(n):
            for x in range(n):
                if prev[y][x] and not all(0 <= x + dx < n and 0 <= y + dy < n and prev[y + dy][x + dx]
                                          for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    out[y][x] = False
    return out


# Íconos 16×16: '#' claro, '+' medio, '.' oscuro (acento). Diseñados a mano.
ICONS = {
    'hook': ["......##........", ".....#..#.......", "......##........", "......#.........", "......#.........", "......#.........",
             "......#.........", "......#.........", "......#.........", "..#...#.........", ".##...#.........", "..#...#.........",
             "..#..#..........", "...##...........", "................", "................"],
    'fish': ["................", "................", "................", "......####......", "....########..##", "...##.#######.##",
             "..###########+#.", "..###########+..", "...#########.##.", "....########..##", "......####......", "................",
             "................", "................", "................", "................"],
    'net': ["################", "#.#.#.#.#.#.#.#.", "#..#..#..#..#..#", ".#..#..#..#..#..", ".#.#.#.#.#.#.#..", "..#..#..#..#..#.",
            "..#.#.#.#.#.#.#.", "...#..#+#+#..#..", "...#.#.###.#.#..", "....#..#+#..#...", "....#.#.#.#.#...", ".....#..#..#....",
            ".....#.#.#.#....", "......#...#.....", ".......###......", "................"],
    'anchor': [".......##.......", "......#..#......", ".......##.......", "....########....", ".......##.......", ".......##.......",
               ".......##.......", ".......##.......", ".......##.......", ".#.....##.....#.", "###....##....###", ".##....##....##.",
               "..##...##...##..", "...###.##.###...", ".....######.....", "................"],
    'eye': ["................", "................", "................", ".....######.....", "...##......##...", "..#...++++...#..",
            ".#...++..++...#.", "#....+.##.+....#", "#....+.##.+....#", ".#...++..++...#.", "..#...++++...#..", "...##......##...",
            ".....######.....", "................", "................", "................"],
    'gem': ["................", "................", "....########....", "...#+#++++#+#...", "..#++#++++#++#..", ".##############.",
            ".#+++#++++#+++#.", "..#++#++++#++#..", "...#+#++++#+#...", "....#.#++#.#....", ".....#.##.#.....", "......#..#......",
            ".......##.......", "................", "................", "................"],
    'crown': ["................", "................", ".#.....##.....#.", ".#.....##.....#.", ".##...####...##.", ".##...####...##.",
              ".###.######.###.", ".##############.", ".##############.", ".##+##+##+##+##.", ".##############.", ".##############.",
              "................", ".##############.", "................", "................"],
    'eclipse': [".......#........", "..#....#....#...", "...#.......#....", ".....#####......", "....###.....#...", "#..##+.......#..",
                "..##+.........##", "..##+..........#", "..##+..........#", "..##+.........#.", "...##+.......#..", "....###.....#...",
                ".....#####......", "...#.......#....", "..#....#....#...", ".......#........"],
    'book': ["................", "................", ".######..######.", ".#++++#..#++++#.", ".#+..+#..#+..+#.", ".#++++#..#++++#.",
             ".#+..+#..#+..+#.", ".#++++#..#++++#.", ".#+..+#..#+..+#.", ".#++++#..#++++#.", ".#++++##.#++++#.", ".######..######.",
             "..#####..#####..", "................", "................", "................"],
    'books': ["................", "...........###..", "..###......#+#..", "..#+#.###..#+#..", "..#+#.#+#..#+#..", "..#.#.#+#..#.#..",
              "..#+#.#.#.###.#.", "..#+#.#+#.#+#.#.", "..#+#.#+#.#+#.#.", "..#.#.#+#.#.#.#.", "..#+#.#.#.#+#.#.", "..#+#.#+#.#+#.#.",
              "..#+#.#+#.#+#.#.", "################", "................", "................"],
    'scroll': ["................", ".##############.", "#++############.", "#++#..........#.", ".###.######...#.", "...#..........#.",
               "...#.########.#.", "...#..........#.", "...#.#######..#.", "...#..........#.", "...#.#####....#.", "...#..........#.",
               "...###########++", "...############+", "................", "................"],
    'sprout': ["................", "..###......####.", ".#++##....#+++#.", ".#+++##..##+++#.", "..#+++#.#+++##..", "...##+####+##...",
               ".....##+##......", ".......##.......", ".......##.......", ".......##.......", ".......##.......", "....########....",
               "...##########...", "...#++++++++#...", "....########....", "................"],
    'wheat': [".......##.......", "......#..#......", ".....##..##.....", "......#..#......", ".....##..##.....", "......####......",
              ".....##..##.....", "......#..#......", ".....##..##.....", "......####......", ".......##.......", ".......##.......",
              ".......##.......", ".......##.......", ".......##.......", "................"],
    'tractor': ["................", "......######....", "......#++++#....", "......#++++#....", "..###.#++++#....", "..###.######....",
                ".###############", ".###############", ".##############.", ".###+++###..###.", "##.....##..#..#.", "#..###..#..#..#.",
                "#..###..#...##..", "##.....##.......", ".#######........", "................"],
    'sun': ["................", ".......##.......", "..#....##....#..", "...#........#...", ".....######.....", "....##++++##....",
            "...##+#++#+##...", "##.##++++++##.##", "##.##+#++#+##.##", "...##++##++##...", "....##++++##....", ".....######.....",
            "...#........#...", "..#....##....#..", ".......##.......", "................"],
    'castle': ["................", ".......#........", ".......##.......", "......####......", "......#++#......", ".#.#..####..#.#.",
               ".####.#++#.####.", ".#++#.####.#++#.", ".####......####.", ".##############.", ".##############.", ".######..######.",
               ".#####....#####.", ".#####....#####.", ".##############.", "................"],
    'handshake': ["................", "................", "................", "##............##", "###...####...###", "####.##++##.####",
                  ".####+####+####.", "..####+##+####..", "...##########...", "....##+##+##....", ".....######.....", "......####......",
                  "................", "................", "................", "................"],
    'coins': ["................", "................", "......####......", ".....#++++#.....", ".....######.....", "..####.####.....",
              ".#++++##++++#...", ".############...", ".##########.####", ".#++++##+++#++++", ".###########+###", ".##########.####",
              "..########..####", "............##..", "................", "................"],
    'vault': ["................", ".##############.", ".#++++++++++++#.", ".#+..........+#.", ".#+...####...+#.", ".#+..#....#..+#.",
              ".#+.#..##..#.+#.", ".#+.#.####.#.+#.", ".#+.#..##..#.+#.", ".#+..#....#..+#.", ".#+...####...+#.", ".#+..........+#.",
              ".#++++++++++++#.", ".##############.", ".##..........##.", "................"],
    'cart': ["................", "##..............", ".#..............", ".##############.", ".#++++++++++++#.", "..#+#+#+#+#+#+#.",
             "..#++++++++++#..", "...#+#+#+#+#+#..", "...##########...", "...#............", "....##########..", "................",
             ".....##....##...", "....####..####..", ".....##....##...", "................"],
    'chart': ["................", "..............##", "............###.", "...........##...", ".........###....", "...##...##......",
              "..#..#.##.......", ".#....##....##..", "...........####.", "......##...####.", "..##..##...####.", "..##..##...####.",
              "..##..##...####.", "..##..##...####.", "################", "................"],
    'star': [".......##.......", ".......##.......", "......####......", "......####......", "......####......", "################",
             ".##############.", "..############..", "...##########...", "....########....", "....########....", "...####..####...",
             "...###....###...", "..###......###..", "..#..........#..", "................"],
    'stars': ["..........#.....", "..........#.....", ".........###....", "......#######...", "....#...###.....", "....#..##.##....",
              "...###.#...#....", "#########.......", ".#######........", "..#####.........", "..##.##.....#...", ".##...##..#####.",
              ".#.....#...###..", "...........#.#..", "................", "................"],
    'trophy': ["................", "..############..", "##############.#", "#.#####+####.#.#", "#.#####+####.#.#", ".#.#########.##.",
               "..#.#######.##..", "...#.#####.#....", "....#######.....", "......###.......", "......###.......", ".....#####......",
               "....#######.....", "...#########....", "...#########....", "................"],
    'gift': ["................", "...##....##.....", "..#..#..#..#....", "..#...##...#....", "...##.##.##.....", ".#######+######.",
             ".#######+######.", ".#######+######.", "..######+#####..", "..######+#####..", "..######+#####..", "..######+#####..",
             "..######+#####..", "..######+#####..", "..############..", "................"],
    'rod': ["................", "...........##.+.", "..........##..+.", ".........##...+.", "........##....+.", ".......##.....+.",
            "......##.....###", ".....##......###", "..####........#.", ".#++##........#.", ".#++#........##.", "##..............",
            "##..............", "#...............", "................", "................"],
    'rods': ["#..............#", "##............##", ".##..........##.", "..##........##..", "...##......##...", "....##....##....",
             ".....##..##.....", "......####......", "......####......", ".....##..##.....", "...####..####...", "..#++#....#++#..",
             "..#++#....#++#..", ".##..........##.", "##............##", "#..............#"],
    'arsenal': [".......+........", "......+++.......", ".......+........", "..#....#....#...", "..#....#....#...", "...#...#...#....",
                "...#...#...#....", "....#..#..#.....", "....#..#..#.....", ".....#.#.#......", "....##.#.##.....", "...#++####++#...",
                "...#++####++#...", ".....#####......", "......###.......", ".......#........"],
    'tag': ["................", "......#########.", ".....#+++++++++#", "....#+++..+++++#", "...#++++..+++++#", "..#++++++++++++#",
            ".#+++++++++++++#", "#++++#++++++++#.", ".#++++#++++++#..", "..#++++#++++#...", "...#++++#++#....", "....#+++++#.....",
            ".....#+++#......", "......###.......", "................", "................"],
    'clover': ["......####......", ".....######.....", ".....######.....", "......####......", "..##...##...##..", ".####.####.####.",
               ".##############.", ".####.####.####.", "..##...##...##..", "......####......", ".....######.....", ".....######.....",
               "......####......", ".......##.......", "........##......", ".........#......"],
}

ROD_BADGE: dict = {}  # las insignias de cañas usan íconos propios (rod, rods, arsenal)


def draw_badge(a, rod_canvases):
    n = 40
    tier, cat = a['tier'], a['category']
    (tl, tm, td), pips = TIER[tier]
    tl, tm, td = hx(tl), hx(tm), hx(td)
    cl, cm, cd = [hx(c) for c in CAT[cat]]
    cv = Canvas(n)
    c = (n - 1) / 2
    outer = shape_mask(tier, n, 17.5)
    inner = erode(outer, 3)
    rim = erode(inner, 1)
    # Rayos del diamante (tramados)
    if tier == 'diamante':
        for i in range(8):
            ang = math.radians(i * 45 + 22.5)
            for rr in range(15, 20):
                x, y = c + rr * math.cos(ang), c + rr * math.sin(ang)
                if (int(x) + int(y)) % 2 == 0:
                    cv.put(x, y, hx('#e6d6ff', 200))
    for y in range(n):
        for x in range(n):
            if not outer[y][x]:
                continue
            if not inner[y][x]:
                # Metal: luz arriba a la izquierda, sombra abajo a la derecha
                s = (x - c) + (y - c)
                cv.put(x, y, tl if s < -6 else td if s > 6 else tm)
            elif not rim[y][x]:
                cv.put(x, y, td)
            else:
                # Fondo de la categoría con degradé tramado
                t = (y - 4) / (n - 8)
                if t < 0.35:
                    col = cl if (x + y) % 2 == 0 or t < 0.2 else cm
                elif t < 0.7:
                    col = cm
                else:
                    col = cd if (x + y) % 2 == 0 or t > 0.85 else cm
                cv.put(x, y, col)
    # Brillo en la esquina del metal
    for (x, y) in ((11, 7), (10, 8), (9, 9)):
        if outer[y][x] and not inner[y][x]:
            cv.put(x, y, hx('#ffffff'))
    # Ícono centrado (16×16) con sombra de 1 px
    ox, oy = 12, 10
    if a['icon'] in ROD_BADGE:
        names = ROD_BADGE[a['icon']]
        for k, name in enumerate(names):
            rc = rod_canvases[name]
            small = rc.image(1).resize((18, 18), Image.NEAREST)
            dx = ox - 1 + (k - (len(names) - 1) / 2) * 4
            for yy in range(18):
                for xx in range(18):
                    p = small.getpixel((xx, yy))
                    if p[3] > 0 and inner[int(oy - 1 + yy) if oy - 1 + yy < n else n - 1][min(n - 1, int(dx + xx))]:
                        cv.put(dx + xx, oy - 1 + yy, p)
    else:
        rows = ICONS.get(a['icon'], ICONS['star'])
        white, mid, dark = hx('#ffffff'), hx('#dfe6f0'), cd
        for yy, row in enumerate(rows):
            for xx, ch in enumerate(row):
                if ch in '#+' and cv.get(ox + xx + 1, oy + yy + 1) is not None and rim[oy + yy + 1][ox + xx + 1]:
                    if rows[yy + 1][xx + 1] == '.' if yy + 1 < 16 and xx + 1 < 16 else True:
                        cv.put(ox + xx + 1, oy + yy + 1, dark)
        for yy, row in enumerate(rows):
            for xx, ch in enumerate(row):
                if ch == '#':
                    cv.put(ox + xx, oy + yy, white)
                elif ch == '+':
                    cv.put(ox + xx, oy + yy, hx('#ffd84a') if cat in ('economia', 'eventos') else mid)
    cv.outline()
    return cv


def main():
    out_rods = os.path.join(ROOT, 'assets', 'rods')
    out_badges = os.path.join(ROOT, 'assets', 'badges')
    os.makedirs(out_rods, exist_ok=True)
    os.makedirs(out_badges, exist_ok=True)
    rods = {}
    for rid, spec in RODS.items():
        rods[rid] = draw_rod(rid, spec)
        rods[rid].image().save(os.path.join(out_rods, f'{rid}.png'), optimize=True)
    defs = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else []
    for a in defs:
        draw_badge(a, rods).image().save(os.path.join(out_badges, f"{a['id']}.png"), optimize=True)
    for t in TIER:
        draw_badge({'id': t, 'tier': t, 'category': 'progresion', 'icon': 'star'}, rods).image().save(os.path.join(out_badges, f'badge_{t}.png'), optimize=True)
    print(f'{len(rods)} cañas y {len(defs)} insignias (+{len(TIER)} genéricas) en pixel art')


if __name__ == '__main__':
    main()
