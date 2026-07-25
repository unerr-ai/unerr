"""
Decode the secret message hidden in a published Google Doc.

The document contains a table whose rows each specify one Unicode character
and its (x, y) position in a 2D grid. Printed in a fixed-width font, the
filled cells form a picture of uppercase letters.

Coordinate system (matches the sample doc):
  - x increases to the RIGHT, starting at 0 on the left.
  - y increases UPWARD, starting at 0 at the BOTTOM.
So the row with the largest y is printed first (top), and y=0 is printed last.
Any cell without a specified character is a space.
"""

import urllib.request
from html.parser import HTMLParser


class _TableParser(HTMLParser):
    """Collect the text of every <td>/<th> cell, grouped by table row."""

    def __init__(self):
        super().__init__()
        self.rows = []          # list of rows; each row is a list of cell strings
        self._in_cell = False
        self._current_row = None
        self._current_cell = []

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._current_row = []
        elif tag in ("td", "th"):
            self._in_cell = True
            self._current_cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            self._in_cell = False
            if self._current_row is not None:
                self._current_row.append("".join(self._current_cell).strip())
        elif tag == "tr":
            if self._current_row:
                self.rows.append(self._current_row)
            self._current_row = None

    def handle_data(self, data):
        if self._in_cell:
            self._current_cell.append(data)


def _fetch_html(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset)


def print_secret_message(url):
    """
    Fetch the published Google Doc at `url`, parse its grid table, and print
    the grid of characters (the hidden uppercase-letter graphic).
    """
    html = _fetch_html(url)

    parser = _TableParser()
    parser.feed(html)

    # Locate the header row so we know which column is x, char, and y.
    # The document uses headers like "x-coordinate", "Character", "y-coordinate".
    entries = []            # (x, y, char)
    x_idx = y_idx = char_idx = None

    for row in parser.rows:
        lowered = [c.lower() for c in row]
        # Detect the header row and remember the column order.
        if any("x-coordinate" in c or c == "x" for c in lowered):
            for i, c in enumerate(lowered):
                if "x-coordinate" in c or c == "x":
                    x_idx = i
                elif "y-coordinate" in c or c == "y":
                    y_idx = i
                elif "char" in c:
                    char_idx = i
            continue

        # Fall back to positional order (x, char, y) if headers weren't found.
        xi = x_idx if x_idx is not None else 0
        ci = char_idx if char_idx is not None else 1
        yi = y_idx if y_idx is not None else 2

        if max(xi, ci, yi) >= len(row):
            continue
        x_str, char, y_str = row[xi], row[ci], row[yi]
        if not (x_str.isdigit() and y_str.isdigit()):
            continue  # skip anything that isn't a real data row
        entries.append((int(x_str), int(y_str), char))

    if not entries:
        print("")  # nothing to draw
        return

    max_x = max(x for x, _, _ in entries)
    max_y = max(y for _, y, _ in entries)

    # Build the grid filled with spaces, then place each character.
    grid = [[" "] * (max_x + 1) for _ in range(max_y + 1)]
    for x, y, char in entries:
        grid[y][x] = char

    # y=0 is the bottom row, so print from the top (largest y) down to y=0.
    for y in range(max_y, -1, -1):
        print("".join(grid[y]))


if __name__ == "__main__":
    import sys

    # Use the URL passed on the command line, or fall back to the sample doc.
    SAMPLE = (
        "https://docs.google.com/document/d/e/2PACX-1vSvM5gDlNvt7npYHhp_XfsJvuntUhq184By5xO_pA4b_gCWeXb6dM6ZxwN8rE6S4ghUsCj2VKR21oEP/pub"
    )
    doc_url = sys.argv[1] if len(sys.argv) > 1 else SAMPLE
    print_secret_message(doc_url)