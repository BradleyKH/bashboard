"""Builds the NSIS installer banner images from icons/icon.png (needs Pillow).

Run from anywhere: python src-tauri/installer/make_images.py
"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ICON = HERE.parent / "icons" / "icon.png"
BG = (1, 7, 12)  # matches the app's #01070c backdrop


def render(size: tuple[int, int], icon_px: int, pos: tuple[int, int], out: str) -> None:
    img = Image.new("RGB", size, BG)
    icon = Image.open(ICON).convert("RGBA").resize((icon_px, icon_px), Image.LANCZOS)
    img.paste(icon, pos, icon)
    img.save(HERE / out, format="BMP")


# Header: icon right-aligned, vertically centered (NSIS draws the page title on the left).
render((150, 57), 45, (150 - 45 - 6, 6), "header.bmp")
# Sidebar: icon centered in the upper part of the welcome/finish panel.
render((164, 314), 104, ((164 - 104) // 2, 60), "sidebar.bmp")
