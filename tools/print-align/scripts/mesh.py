import cv2, numpy as np, sys
from scipy.spatial import cKDTree
DPI=600; MM=25.4/DPI
p=sys.argv[1]; dark=sys.argv[2]=='dark'
g=cv2.cvtColor(cv2.imread(p),cv2.COLOR_BGR2GRAY)
if not dark: g=255-g  # (white backing: holes slightly darker? keep simple)
m=(g<90).astype(np.uint8) if dark else None
n,lab,st,cen=cv2.connectedComponentsWithStats(m)
a=st[:,4]; ok=(a>60)&(a<900)
pts=cen[ok]
print("hole blobs:",len(pts))
# lattice vectors from nearest neighbours
t=cKDTree(pts); d,i=t.query(pts,k=5)
vec=(pts[i[:,1:]]-pts[:,None]).reshape(-1,2); dist=np.hypot(*vec.T)
pitch=np.median(dist[dist<60]); print(f"median pitch {pitch:.2f}px = {pitch*MM:.3f}mm = {25.4/(pitch*MM):.2f} per inch")
# basis: vectors near +x and +y
vx=vec[(np.abs(vec[:,1])<pitch*.4)&(vec[:,0]>0)&(dist<pitch*1.4)]; vy=vec[(np.abs(vec[:,0])<pitch*.4)&(vec[:,1]>0)&(dist<pitch*1.4)]
ex=np.median(vx,0); ey=np.median(vy,0)
ang=np.degrees(np.arccos(ex@ey/np.hypot(*ex)/np.hypot(*ey)))-90
print(f"ex={ex.round(2)} ey={ey.round(2)}  |ex|={np.hypot(*ex)*MM:.3f}mm |ey|={np.hypot(*ey)*MM:.3f}mm  skew from 90deg={-ang:+.2f}deg")
# assign integer lattice coords via flood from a seed using local steps
c0=pts[np.argmin(np.hypot(*(pts-np.median(pts,0)).T))]
B=np.stack([ex,ey],1); ij=np.linalg.solve(B,(pts-c0).T).T
# iterative local refinement: BFS
idx=t.query(c0)[1]; coord={idx:(0,0)}; q=[idx]
while q:
    k=q.pop()
    ci,cj=coord[k]
    for di,dj in ((1,0),(-1,0),(0,1),(0,-1)):
        guess=pts[k]+di*ex+dj*ey
        dd,nb=t.query(guess)
        if dd<pitch*.35 and nb not in coord:
            coord[nb]=(ci+di,cj+dj); q.append(nb)
ks=np.array(list(coord)); IJ=np.array([coord[k] for k in ks]); P=pts[ks]
print("lattice-assigned holes:",len(ks), " cols",np.ptp(IJ[:,0])+1," rows",np.ptp(IJ[:,1])+1)
# best affine fit grid -> residuals = how non-grid the canvas is
X=np.c_[IJ,np.ones(len(IJ))]; sol,*_=np.linalg.lstsq(X,P,rcond=None); r=P-X@sol; rr=np.hypot(*r.T)*MM
print(f"deviation from best perfect (affine) grid: mean {rr.mean():.2f}mm  95% {np.percentile(rr,95):.2f}mm  max {rr.max():.2f}mm   (pitch {pitch*MM:.2f}mm)")
np.savez('work/mesh_'+('dark' if dark else 'white')+'.npz',IJ=IJ,P=P,res=r)
# visual: residual map
H,W=g.shape; vis=np.full((H//8,W//8,3),255,np.uint8)
mx=np.percentile(rr,99)
for (x,y),v in zip(P,rr):
    c=int(255*min(v/mx,1)); cv2.circle(vis,(int(x/8),int(y/8)),2,(255-c,255-c,255) if False else (int(255-c),0,c),-1)
cv2.imwrite('work/mesh_residual_map.png',vis)
