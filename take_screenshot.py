#!/usr/bin/env python3
import sys
from PIL import ImageGrab

def take_screenshot(output_path):
    try:
        screenshot = ImageGrab.grab()
        screenshot.save(output_path, 'WEBP')
        print(f"Screenshot saved to {output_path}")
        return True
    except Exception as e:
        print(f"Error taking screenshot: {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: take_screenshot.py <output_path>")
        sys.exit(1)
    
    output_path = sys.argv[1]
    if take_screenshot(output_path):
        sys.exit(0)
    else:
        sys.exit(1)
