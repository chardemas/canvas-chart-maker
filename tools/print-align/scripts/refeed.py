import cv2, numpy as np, sys
DPI=600; MM=25.4/DPI
def marks(path):
    im=cv2.imread(path); hsv=cv2.cvtColor(im,cv2.COLOR_BGR2HSV)
    h,s,v=[hsv[...,i].astype(int) for i in range(3)]
    black=((v<110)&(s<90)).astype(np.uint8)
    mag=((s>60)&(h>135)&(h<175)&(v>100)).astype(np.uint8)
    # find mark blobs on a dilated union
    k=cv2.dilate(black|mag,np.ones((25,25),np.uint8))
    n,lab,st,cen=cv2.connectedComponentsWithStats(k)
    out=[]
    for i in range(1,n):
        x,y,w,hh,a=st[i]
        if not (150<w<350 and 150<hh<350): continue
        sl=(slice(y,y+hh),slice(x,x+w))
        def c(m):
            ys,xs=np.nonzero(m[sl]); return (xs.mean()+x, ys.mean()+y, len(xs))
        bx,by,bn=c(black); mx,my,mn=c(mag)
        if bn<200 or mn<200: continue
        out.append((bx,by,mx-bx,my-by))
    return np.array(out)
for p in sys.argv[1:]:
    m=marks(p); d=m[:,2:]*MM
    print(f"\n{p}: {len(m)} marks")
    print(f"  mean shift dx={d[:,0].mean():+.2f}mm dy={d[:,1].mean():+.2f}mm   spread(sd) x={d[:,0].std():.2f} y={d[:,1].std():.2f}   max |shift|={np.hypot(*d.T).max():.2f}mm")
    # fit affine: magenta = A*black + t ; residual
    src=m[:,:2]; dst=src+m[:,2:]
    A,_=cv2.estimateAffine2D(src.astype(np.float32),dst.astype(np.float32),method=cv2.LMEDS)
    pred=src@A[:,:2].T+A[:,2]; r=np.hypot(*(dst-pred).T)*MM
    sx=np.hypot(A[0,0],A[1,0]); sy=np.hypot(A[0,1],A[1,1]); rot=np.degrees(np.arctan2(A[1,0],A[0,0]))
    print(f"  affine: scale x={sx:.5f} y={sy:.5f} rot={rot:+.3f}deg  -> residual after affine: mean={r.mean():.2f} max={r.max():.2f}mm")
    # row-by-row dy (feed direction) to see feed nonuniformity
    rows=np.round((m[:,1]-m[:,1].min())/DPI).astype(int)
    print("  per-row dy mm:", " ".join(f"{d[rows==k,1].mean():+.2f}" for k in sorted(set(rows))))
    print("  per-row dx mm:", " ".join(f"{d[rows==k,0].mean():+.2f}" for k in sorted(set(rows))))
