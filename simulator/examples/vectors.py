# vec2 is a 2D point with .x and .y. It supports arithmetic (+ - *) and
# helpers like .length() and .normalized(), so it's handy for positions and
# velocities.

badge.mode(HIRES)

pos = vec2(160, 120)
vel = vec2(2.6, 1.9)

while True:
    # Move, then bounce off the edges by flipping a velocity component.
    pos = pos + vel
    if pos.x < 8 or pos.x > screen.width - 8:
        vel.x = -vel.x
    if pos.y < 8 or pos.y > screen.height - 8:
        vel.y = -vel.y

    # Colour the ball by its current speed.
    speed = vel.length()
    screen.pen = color.hsv(min(speed / 6, 1.0), 0.9, 1.0)
    screen.circle(pos, 8)

    screen.pen = color.white
    screen.text("vec2 bounce", 10, 10)

    badge.update()
