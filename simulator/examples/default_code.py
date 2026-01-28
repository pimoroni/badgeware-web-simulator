mode(HIRES)

def update():
  # create a flower shape path
  path1 = []
  for i in range(0, 360, 5):
    scale = (sin(((i + io.ticks / 50)) * 5 * PI / 180) * (screen.height // 12)) + (screen.height // 4)
    x = sin(i * PI / 180) * scale
    y = cos(i * PI / 180) * scale
    path1.append(vec2(x + (screen.width // 2), y + (screen.height // 2)))

  # define a simple square "hole" path
  scale = 2 if screen.width == 320 else 1
  path2 = [vec2(70 * scale, 50 * scale), vec2(90 * scale, 50 * scale), vec2(90 * scale, 70 * scale), vec2(70 * scale, 70 * scale)]

  # construct a new polygon from the path
  poly = shape.custom(path1, path2)

  # draw the polygon to the display
  screen.shape(poly)

  screen.text("Hello World", 10, 10)

