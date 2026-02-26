menu_items = ["item 1", "item 2", "item 3", "item 4"]
selected_item = 0

def update():
  global selected_item

  # adjust selected item index based on button presses
  if BUTTON_UP in badge.pressed():
    selected_item -= 1

  if BUTTON_DOWN in badge.pressed():
    selected_item += 1

  # wrap and clamp selected index to the range of items in the menu
  selected_item %= len(menu_items)

  # draw the menu on the screen
  screen.pen = color.rgb(255, 255, 255)

  for i in range(len(menu_items)):
    # if this is the selected item then highlight it
    if i == selected_item:
      screen.text(">", 0, i * 10)

    # write the menu item label
    screen.text(menu_items[i], 10, i * 10)

