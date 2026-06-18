# mat3 is a 2D transform. Chain translate / rotate / scale, then assign it to
# a shape's .transform before drawing. rotate() is in degrees.
#
# Build the shape once around the origin (0, 0) and let the matrix place it.

badge.mode(HIRES)

star = shape.star(0, 0, 5, 40, 18)

while True:
    screen.antialias = image.X2

    angle = badge.ticks / 10
    star.transform = mat3().translate(160, 120).rotate(angle).scale(1.5)

    screen.pen = color.rgb(255, 200, 40)
    screen.shape(star)

    screen.pen = color.white
    screen.text("mat3 transform", 10, 10)

    badge.update()
