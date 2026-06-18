# The shape factory builds vector shapes you draw with screen.shape().
#
# Every factory takes an x, y position first. Angles (for arcs and pies) are
# given in degrees. Turn on antialiasing for smooth edges.

badge.mode(HIRES)

while True:
    screen.antialias = image.X2

    # rectangle(x, y, w, h) and circle(x, y, radius)
    screen.pen = color.rgb(255, 80, 80)
    screen.shape(shape.rectangle(20, 20, 60, 40))
    screen.pen = color.rgb(80, 160, 255)
    screen.shape(shape.circle(150, 40, 25))

    # star(x, y, points, outer_radius, inner_radius)
    screen.pen = color.yellow
    screen.shape(shape.star(60, 150, 5, 35, 16))

    # pie(x, y, radius, from_angle, to_angle) — angles in degrees, spinning
    spin = badge.ticks / 20
    screen.pen = color.lime
    screen.shape(shape.pie(180, 150, 35, spin, spin + 270))

    badge.update()
