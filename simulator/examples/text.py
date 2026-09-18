# screen.text() word-wraps rich text inside a rect. [tags] in the string call
# inline glyph renderers - the built-in [pen:r,g,b] changes pen colour
# mid-sentence, [sprite:name] blits an image registered with add_sprite(), and
# add_glyph() registers your own.

import math

badge.mode(HIRES)

skull = image.load("/system/assets/skull.png")
add_sprite("skull", skull)
screen.font = font.compass


# A renderer is fn(image, params, measure): it returns its advance width when
# measuring, else draws at image.cursor and returns None.
def circle_glyph_renderer(image, _parameters, measure):
  if measure:
    return 12

  image.shape(shape.circle(image.cursor.x + 6, image.cursor.y + 7, 6))
  return None


add_glyph("circle", circle_glyph_renderer)


while True:
  message = """[pen:180,150,120]Upon the mast I gleam and grin, A sentinel of bone and sin. Wind and thunder, night and hull- None fear the sea like a [pen:230,220,200]pirate skull[pen:180,150,120][sprite:skull].
"""

  screen.pen = color.rgb(100, 255, 100, 150)

  x = 5
  y = 5
  width = math.sin(badge.ticks / 500) * 50 + 200
  height = 220
  bounds = rect(x, y, width, height)
  screen.text(message, bounds, line_height=1, word_spacing=1.05)

  screen.pen = color.rgb(60, 80, 100, 100)
  screen.line(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y)
  screen.line(bounds.x, bounds.y, bounds.x, bounds.y + bounds.h)
  screen.line(bounds.x, bounds.y + bounds.h, bounds.x + bounds.w, bounds.y + bounds.h)
  screen.line(bounds.x + bounds.w, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h)
  badge.update()
