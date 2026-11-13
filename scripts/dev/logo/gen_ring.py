"""Generates window.sftkRagdollRing in debug-logger.js (the loading mascot of both apps).

  py -3 -X utf8 scripts/dev/logo/gen_ring.py [rearAngle chestAngle]      then: node scripts/dev/logo/ringdemo.mjs

Our own drawing (owner 2026-11-14): the ragdoll of the icon lying ON HIS BACK and flying round a circle — a thick,
gently curved body with the white belly showing, a big head at the front looking at the screen, two short front paws
at his shoulders pointing ahead, two long back legs stretched out behind with a gap between them, and a tail that stretches
out behind him as he sprints and catches up as he slows. Angles are clockwise from 12 o'clock, before the mirror; the whole group is mirrored and turned
counter-clockwise by CSS (styles.css).
"""
import io, math, sys
ROOT = 'C:/Users/yonas/OneDrive/Desktop/Saleforce Toolkit/'
A0 = float(sys.argv[1]) if len(sys.argv) > 1 else 112.0    # the rear end of the body
A1 = float(sys.argv[2]) if len(sys.argv) > 2 else 196.0    # the chest end of the body
RAD = 24.0                                                 # the circle he flies round = the middle line of the body
HALF = 6.6                                                 # half the body's thickness
f = lambda v: ('%.3f' % v)
E, CO, P, EYE = 'var(--rag-edge,#8F92A0)', 'var(--rag-coat,#F6F2EC)', 'var(--rag-point,#9B9EAC)', 'var(--rag-eye,#7CC3F7)'
SHADE, WHITE = 'var(--rag-shade,#E4DBCF)', 'var(--rag-white,#FFFFFF)'


def pt(a, r):
    t = math.radians(a)
    return 32 + r * math.sin(t), 32 - r * math.cos(t)


def P2(a, r):
    x, y = pt(a, r)
    return f'{f(x)} {f(y)}'


def frame(a):
    """unit vectors at angle a: forward (the way he flies) and inward (toward the centre)"""
    t = math.radians(a)
    return (math.cos(t), math.sin(t)), (-math.sin(t), math.cos(t))


def arc(a0, a1, r, col, w):
    c = 2 * math.pi * r
    d = c * (a1 - a0) / 360
    return f'<circle cx="32" cy="32" r="{f(r)}" fill="none" stroke="{col}" stroke-width="{w}" stroke-linecap="round" stroke-dasharray="{f(d)} {f(c - d)}" transform="rotate({f(a0 - 90)} 32 32)"/>'


def stroke(d, col, w, extra=''):
    return f'<path d="{d}" fill="none" stroke="{col}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"{extra}/>'


S, note = [], {}


def add(svg, comment=None):
    if comment: note[len(S)] = comment
    S.append(svg)


def limb(x0, y0, x1, y1, w, tip):
    """a leg or an arm: a round-ended bar with a soft edge and a blue-grey mitten on its far end"""
    d = f'M{f(x0)} {f(y0)} L{f(x1)} {f(y1)}'
    add(stroke(d, E, f(w + 1.8))); add(stroke(d, CO, f(w)))
    add(stroke(f'M{f(x1 + (x0 - x1) * tip)} {f(y1 + (y0 - y1) * tip)} L{f(x1)} {f(y1)}', P, f(w)))


AH = A1 + 12                                               # where the head sits
fwd_h, inward_h = frame(AH)
hx, hy = pt(AH, RAD)
fwd0, in0 = frame(A0)
rx, ry = pt(A0, RAD)                                       # the middle of the rear end

# (a cape was tried — tied at the neck, stretching and fluttering — and taken out again: owner 2026-11-14, "lets take
#  the cape out and leave it like this with the tail")

# ── the tail: it STRETCHES out behind him as he sprints and catches up as he slows (owner 2026-11-14: "an effect
#    at the tail. like making him stretch and then follow the cat as he flies"). A stroke along the circle, anchored at
#    his rear and running backward; CSS animates its length (styles.css, .sftk-cat-tail). ──
def tail_arc(col, w):
    c = 2 * math.pi * RAD
    # flipped so the dash starts at the rear and runs BACKWARD along the circle
    return (f'<circle class="sftk-cat-tail" cx="32" cy="32" r="{f(RAD)}" fill="none" stroke="{col}" stroke-width="{w}" stroke-linecap="round" '
            f'stroke-dasharray="21 {f(c)}" transform="rotate({f(A0 + 4 - 90)} 32 32) translate(0 64) scale(1 -1)"/>')


add(tail_arc(E, '6.600'), 'the tail: a stroke along the circle from his rear backward — its length is animated: it stretches, then follows')
add(tail_arc(P, '4.800'))

# ── the back legs: two long bars stretched out behind, a gap between them ──
note[len(S)] = 'the back legs: two long bars stretched out behind him, a gap between them, blue-grey mittens'
for side, splay, length in ((1, 2.4, 13.5), (-1, 1.2, 12.0)):          # side: +1 = inside of the curve
    x0, y0 = rx + fwd0[0] * 3 + in0[0] * side * (HALF * 0.52), ry + fwd0[1] * 3 + in0[1] * side * (HALF * 0.52)
    x1, y1 = x0 - fwd0[0] * (length + 3) + in0[0] * side * splay, y0 - fwd0[1] * (length + 3) + in0[1] * side * splay
    limb(x0, y0, x1, y1, 5.4, 0.28)

# ── the body, belly up ──
add(arc(A0, A1, RAD, E, f(HALF * 2 + 1.8)), 'the body: thick and gently curved — an arc of the circle he flies round — belly up')
add(arc(A0, A1, RAD, CO, f(HALF * 2)))
add(arc(A0 + 3, A1 - 2, RAD + HALF - 1.9, SHADE, '2.200'), 'the warmer sides, the white belly down the middle, the white ruff on the chest')
add(arc(A0 + 3, A1 - 2, RAD - HALF + 1.9, SHADE, '2.200'))
add(arc(A0 + 10, A1 - 26, RAD, WHITE, '3.600'))
add(arc(A1 - 12, A1 - 2, RAD, WHITE, '9.200'))
add(stroke(f'M{P2(A0 + 13, RAD + HALF - 0.6)} Q{P2(A0 + 5, RAD + 1.6)} {P2(A0 + 11, RAD - 0.6)} M{P2(A0 + 13, RAD - HALF + 0.6)} Q{P2(A0 + 6, RAD - 2.4)} {P2(A0 + 12, RAD - 3.6)}', E, '1', ' opacity="0.650"'), 'the lines of the haunches')

# ── the front paws, as in the reference once it was looked at closely (2026-11-14): the arms come from the SHOULDERS
#    under his chin and lie back along each SIDE of the body, part of its outline — only a soft contour — with the
#    mittens at their rear ends, resting on his sides. ──
note[len(S)] = "the front paws: arms from the shoulders lying back along each side of the body, the mittens resting on his sides"
for side in (1, -1):
    r = RAD + side * (HALF - 3.4)          # well inside the outline: a paw must never poke out of his side
    # the arm on the OUTSIDE of the curve runs on a bigger circle, so the same angle makes it longer — it is given a
    # shorter angle (owner 2026-11-14: "the bottom hand needs to be a bit shorter")
    back = 37.0 if side == 1 else 39.0
    add(arc(A1 - back, A1 - 14, r, SHADE, '5.400')); add(arc(A1 - back, A1 - 14, r, CO, '4'))
    tip = 4.4 if side == 1 else 5.4
    add(arc(A1 - back - 0.5, A1 - back + tip, r, E, '5.400')); add(arc(A1 - back - 0.5, A1 - back + tip, r, P, '4'))

# ── the head: big, over the front of the body, its top pointing ahead and inward, the face to the screen ──
# the head sits STRAIGHT on the body: its top points the way he flies (a slight lean inward), its chin back along the
# body's middle line — so the two paws sit evenly at either side of the chin (owner 2026-11-14: "the head is not placed
# correctly so it makes the front hands look weird")
vx, vy = inward_h[0] * 0.14 + fwd_h[0] * 0.99, inward_h[1] * 0.14 + fwd_h[1] * 0.99
theta = math.degrees(math.atan2(vx, -vy))
head = (f'<g transform="translate({f(hx)} {f(hy)}) rotate({f(theta)}) scale(1.060)">'
        f'<path d="M-10 -2 L-10.500 -12.500 L-2 -7.500 Z M10 -2 L10.500 -12.500 L2 -7.500 Z" fill="{P}"/>'
        f'<path d="M-8.300 -4.500 L-8.600 -9.800 L-4.300 -7.200 Z M8.300 -4.500 L8.600 -9.800 L4.300 -7.200 Z" fill="var(--rag-ear,#C7B5C6)"/>'
        f'<ellipse cx="0" cy="0.500" rx="11.200" ry="9.500" fill="{E}"/>'
        f'<ellipse cx="0" cy="0.500" rx="10.400" ry="8.700" fill="{CO}"/>'
        f'<path d="M-2.400 -8 L2.400 -8 L1.300 1 L-1.300 1 Z" fill="{P}"/>'
        f'<ellipse cx="0" cy="4.200" rx="4" ry="3.300" fill="{P}"/>'
        f'<circle cx="-5.200" cy="0" r="3" fill="{EYE}"/><circle cx="5.200" cy="0" r="3" fill="{EYE}"/>'
        '<circle cx="-5" cy="0" r="1.400" fill="#0B2545" class="sftk-cat-eye"/><circle cx="5" cy="0" r="1.400" fill="#0B2545" class="sftk-cat-eye"/>'
        '<circle cx="-4.300" cy="-0.800" r="0.600" fill="#FFFFFF"/><circle cx="5.700" cy="-0.800" r="0.600" fill="#FFFFFF"/>'
        '<path d="M-1.400 3 h2.800 l-1.400 1.700 z" fill="#4A4D5C"/>'
        '<path d="M0 4.700 v0.900 M0 5.600 q-1.300 1.300 -2.500 0.200 M0 5.600 q1.300 1.300 2.500 0.200" fill="none" stroke="#4A4D5C" stroke-width="0.700" stroke-linecap="round"/>'
        f'<path d="M-8.800 3.200 h-4.400 M-8.600 5.200 l-4.200 1.200 M8.800 3.200 h4.400 M8.600 5.200 l4.200 1.200" fill="none" stroke="{E}" stroke-width="0.600" stroke-linecap="round"/>'
        '</g>')
add(head, "the head: the icon's face, looking at the screen — ears, the blaze and muzzle, blue eyes, whiskers")

L = ["  window.sftkRagdollRing = function (size) {",
     "    const s = size || 56;",
     "    return '<svg class=\"sftk-cat sftk-cat-load sftk-cat-ringcat\" width=\"' + s + '\" height=\"' + s +",
     "      '\" viewBox=\"-11 -11 86 86\" xmlns=\"http://www.w3.org/2000/svg\" aria-hidden=\"true\">' +",
     "        '<g class=\"sftk-cat-ring\"><g transform=\"translate(64 0) scale(-1 1)\">' +"]
for i, svg in enumerate(S):
    assert "'" not in svg, svg
    if i in note: L.append('          // ' + note[i])
    L.append("          '" + svg + "' +")
L += ["        '</g></g>' +", "      '</svg>';", "  };"]
p = ROOT + 'debug-logger.js'
s = io.open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
i = s.index('  window.sftkRagdollRing = function (size) {')
j = s.index('  window.sftkCatSvg = function (mood, size) {', i)
s = s[:i] + nl.join(L) + nl + s[j:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok', A0, A1)
