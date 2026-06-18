# Animate with badge.ticks — the number of milliseconds since the badge
# booted. Feed it into sin/cos for smooth, looping motion.

from math import sin, cos

badge.mode(HIRES)

while True:
    t = badge.ticks / 1000

    # A circle orbiting the centre of the screen.
    cx, cy = screen.width / 2, screen.height / 2
    x = cx + cos(t * 2) * 90
    y = cy + sin(t * 2) * 70

    # Cycle the hue over time too.
    screen.pen = color.hsv((t * 0.2) % 1.0, 0.8, 1.0)
    screen.circle(int(x), int(y), 14)

    screen.pen = color.white
    screen.text("badge.ticks animation", 10, 10)

    badge.update()
