"""Generate PWA icons for schedule.html.

Run: python3 make_icons.py
Outputs: icons/icon-180.png, icon-192.png, icon-512.png, icon-maskable-512.png
"""
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT_DIR, exist_ok=True)

TEAL   = (78, 205, 196, 255)   # #4ECDC4
WHITE  = (255, 255, 255, 255)
CORAL  = (255, 107, 107, 255)  # #FF6B6B
YELLOW = (255, 217, 61,  255)  # #FFD93D
PURPLE = (92, 122, 234, 255)   # #5C7AEA

def draw_icon(size, padding_ratio=0.12):
    """Draw an icon. padding_ratio controls the inner safe-area margin."""
    img = Image.new("RGBA", (size, size), TEAL)
    draw = ImageDraw.Draw(img)

    margin = int(size * padding_ratio)
    card_left, card_top = margin, margin
    card_right, card_bottom = size - margin, size - margin
    card_w = card_right - card_left
    card_h = card_bottom - card_top
    card_radius = int(size * 0.10)

    draw.rounded_rectangle(
        [card_left, card_top, card_right, card_bottom],
        radius=card_radius,
        fill=WHITE,
    )

    # three colored bars representing timeline blocks
    bars = [
        (CORAL,  0.62),
        (YELLOW, 0.78),
        (PURPLE, 0.50),
    ]
    bar_h = int(card_h * 0.13)
    bar_gap = int(card_h * 0.09)
    total = len(bars) * bar_h + (len(bars) - 1) * bar_gap
    y = card_top + (card_h - total) // 2
    bar_left = card_left + int(card_w * 0.14)
    bar_radius = bar_h // 2

    for color, w_ratio in bars:
        bar_right = bar_left + int(card_w * 0.72 * w_ratio / 0.78)  # normalize
        draw.rounded_rectangle(
            [bar_left, y, bar_right, y + bar_h],
            radius=bar_radius,
            fill=color,
        )
        # small dot at the left edge of each bar
        dot_r = bar_h // 2
        dot_cx = card_left + int(card_w * 0.10)
        dot_cy = y + bar_h // 2
        draw.ellipse(
            [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
            fill=color,
        )
        y += bar_h + bar_gap

    return img


# Standard icons (small inner padding)
for size in (180, 192, 512):
    path = os.path.join(OUT_DIR, f"icon-{size}.png")
    draw_icon(size, padding_ratio=0.10).save(path, "PNG")
    print(f"wrote {path}")

# Maskable: Android applies its own mask with up to ~20% trim per side.
# Keep all content within the central 80%, so use a larger padding.
mask_path = os.path.join(OUT_DIR, "icon-maskable-512.png")
draw_icon(512, padding_ratio=0.22).save(mask_path, "PNG")
print(f"wrote {mask_path}")
