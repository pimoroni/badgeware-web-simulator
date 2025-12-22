# the character's position
pos_x, pos_y = 80, 60

# the character's motion vector
dir_x, dir_y = 0, 0

# character's max run speed
max_dir_x = 2

def update():
  global dir_x, dir_y, pos_x, pos_y

  if io.pressed:
    print(io.pressed)

  if io.BUTTON_A in io.held:
    # move left
    dir_x = -1
  elif io.BUTTON_C in io.held:
    # move right
    dir_x = 1

  if io.BUTTON_B in io.pressed:
    # jump when B is pressed
    dir_y = -3

  # apply gravity and dampen sideways movement
  dir_x *= 0.8
  dir_y += 0.1

  pos_x += dir_x
  pos_y += dir_y

  # clamp to floor
  if pos_y > 60:
    dir_y = 0
    pos_y = 60

  # draw the floor
  screen.pen = color.rgb(255, 255, 255)
  screen.shape(shape.rectangle(0, 60, 160, 10))

  # draw the character
  screen.pen = color.rgb(255, 0, 255)
  screen.shape(shape.circle(pos_x, pos_y, 3))