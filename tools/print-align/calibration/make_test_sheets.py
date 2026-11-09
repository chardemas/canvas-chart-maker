"""Printer re-feed test sheets: pass 1 (black) then pass 2 (magenta) on the SAME paper.
Print both at 100% / Actual size. The offset between the two sets of crosshairs = printer feed error."""
import matplotlib
matplotlib.use("pdf")
import matplotlib.pyplot as plt

W, H = 8.5, 11.0
ARM = 0.18  # crosshair half-length, inches

def sheet(path, color, label, ring):
    fig = plt.figure(figsize=(W, H))
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.axis("off")
    xs = [0.75 + i for i in range(8)]
    ys = [0.75 + j for j in range(10)]
    for x in xs:
        for y in ys:
            ax.plot([x - ARM, x + ARM], [y, y], color=color, lw=0.35)
            ax.plot([x, x], [y - ARM, y + ARM], color=color, lw=0.35)
            ax.add_patch(plt.Circle((x, y), ring, fill=False, color=color, lw=0.35))
    ax.text(W / 2, 0.35, label, ha="center", va="center", fontsize=9, color=color)
    # corner arrow showing feed direction (top edge goes in first)
    ax.annotate("", xy=(0.3, 0.2), xytext=(0.3, 0.6), arrowprops=dict(arrowstyle="->", color=color, lw=0.6))
    fig.savefig(path)
    plt.close(fig)

sheet("test_pass1_black.pdf", "black", "PASS 1 - black - print at 100% (Actual size)", 0.06)
sheet("test_pass2_magenta.pdf", "#ff00ff", "PASS 2 - magenta - same sheet, same way up", 0.09)
