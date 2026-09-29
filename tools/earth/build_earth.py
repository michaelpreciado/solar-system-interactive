"""
Generate the Earth texture set with Blender (bpy, headless Cycles baking).

Blender does the heavy lifting: a shader-node graph (domain-warped fBm
continents, ridged mountains, biomes, sea ice, city clusters, storm-swirled
clouds) is baked to equirectangular images on a UV sphere with Cycles.
numpy/Pillow then derive the tangent-space normal map, spec/roughness map and
encode compact WebP files plus manifest.json.

    python -m venv .venv && .venv/bin/pip install bpy==4.2.0 numpy pillow
    .venv/bin/python tools/earth/build_earth.py [--out public/textures/earth] [--seed 7]

Pass 1 bakes the height field so the sea level can be set at the 70.8 % ocean
quantile; pass 2 bakes albedo / aux (ice, cities) / clouds using that level.
"""
import argparse, json, math, os, sys
import numpy as np
import bpy
from PIL import Image

W, H = 2048, 1024


# ------------------------------------------------------------------ nodes ---
class NB:
    """Tiny node-builder helper."""

    def __init__(self, nt):
        self.nt = nt

    def n(self, kind, **kw):
        node = self.nt.nodes.new(kind)
        for k, v in kw.items():
            if k == 'inputs':
                for name, val in v.items():
                    node.inputs[name].default_value = val
            else:
                setattr(node, k, v)
        return node

    def link(self, a, b):
        self.nt.links.new(a, b)

    def val(self, x):
        return self.n('ShaderNodeValue').outputs[0] if x is None else self._v(x)

    def _v(self, x):
        node = self.n('ShaderNodeValue')
        node.outputs[0].default_value = x
        return node.outputs[0]

    def s(self, x):
        """Coerce python float / socket into a socket."""
        return x if hasattr(x, 'node') else self._v(float(x))

    def math(self, op, a, b=None, c=None, clamp=False):
        node = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b, c)):
            if v is None:
                continue
            if hasattr(v, 'node'):
                self.link(v, node.inputs[i])
            else:
                node.inputs[i].default_value = float(v)
        return node.outputs[0]

    def vmath(self, op, a, b=None, scale=None):
        node = self.n('ShaderNodeVectorMath', operation=op)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if hasattr(v, 'node'):
                self.link(v, node.inputs[i])
            else:
                node.inputs[i].default_value = v
        if scale is not None:
            node.inputs['Scale'].default_value = scale
        return node.outputs[0]

    def noise(self, vec, scale, detail=6.0, rough=0.5, lac=2.0, distortion=0.0, w=0.0):
        node = self.n('ShaderNodeTexNoise', noise_dimensions='4D', normalize=True)
        self.link(vec, node.inputs['Vector'])
        node.inputs['W'].default_value = w
        node.inputs['Scale'].default_value = scale
        node.inputs['Detail'].default_value = detail
        node.inputs['Roughness'].default_value = rough
        node.inputs['Lacunarity'].default_value = lac
        node.inputs['Distortion'].default_value = distortion
        return node

    def ramp(self, fac, stops, interp='LINEAR'):
        node = self.n('ShaderNodeValToRGB')
        node.color_ramp.interpolation = interp
        cr = node.color_ramp
        while len(cr.elements) < len(stops):
            cr.elements.new(0.5)
        for el, (pos, col) in zip(cr.elements, stops):
            el.position = pos
            el.color = col
        self.link(fac, node.inputs['Fac'])
        return node.outputs['Color']

    def mix(self, fac, a, b):
        node = self.n('ShaderNodeMix', data_type='RGBA')
        self.link(self.s(fac), node.inputs['Factor'])
        for sock, v in ((node.inputs[6], a), (node.inputs[7], b)):
            if hasattr(v, 'node'):
                self.link(v, sock)
            else:
                sock.default_value = v
        return node.outputs[2]

    def smooth(self, x, lo, hi):
        """smoothstep; `lo` may be a socket, in which case `hi` is the width."""
        width = hi if hasattr(lo, 'node') else hi - lo
        t = self.math('SUBTRACT', x, lo)
        t = self.math('DIVIDE', t, width)
        t = self.math('MULTIPLY', self.math('MAXIMUM', self.math('MINIMUM', t, 1.0), 0.0), 1.0)
        # smoothstep: t*t*(3-2t)
        return self.math('MULTIPLY', self.math('MULTIPLY', t, t), self.math('SUBTRACT', 3.0, self.math('MULTIPLY', t, 2.0)))

    def sep(self, vec):
        node = self.n('ShaderNodeSeparateXYZ')
        self.link(vec, node.inputs[0])
        return node.outputs


def c3(hexs):
    h = hexs.lstrip('#')
    lin = []
    for i in (0, 2, 4):
        v = int(h[i:i + 2], 16) / 255.0
        lin.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    return (*lin, 1.0)


def unit_pos(b):
    geo = b.n('ShaderNodeNewGeometry')
    obj = b.n('ShaderNodeTexCoord')
    return b.vmath('NORMALIZE', obj.outputs['Object'])


def height_socket(b, p, seed):
    """Continental height 0..1 (unnormalised sea level ~0.5-0.6)."""
    off = np.array([seed * 1.37, seed * 2.11, seed * 0.73])
    pp = b.vmath('ADD', p, tuple(off))
    warp = b.noise(pp, 1.6, detail=3, rough=0.5)
    wv = b.vmath('SUBTRACT', warp.outputs['Color'], (0.5, 0.5, 0.5))
    pw = b.vmath('ADD', pp, b.vmath('SCALE', wv, scale=0.75) if False else b.vmath('MULTIPLY', wv, (0.75, 0.75, 0.75)))
    big = b.noise(pw, 1.15, detail=2, rough=0.55, w=seed)
    mid = b.noise(pw, 3.4, detail=7, rough=0.56, lac=2.15, w=seed * 0.3)
    cont = b.math('ADD', b.math('MULTIPLY', big.outputs['Fac'], 0.62), b.math('MULTIPLY', mid.outputs['Fac'], 0.38))
    # ridged mountains, only where already elevated
    rn = b.noise(pw, 9.0, detail=8, rough=0.6, lac=2.2, w=seed * 0.7)
    ridge = b.math('SUBTRACT', 1.0, b.math('ABSOLUTE', b.math('SUBTRACT', b.math('MULTIPLY', rn.outputs['Fac'], 2.0), 1.0)))
    ridge = b.math('POWER', ridge, 2.2)
    mask = b.smooth(cont, 0.50, 0.66)
    hgt = b.math('ADD', cont, b.math('MULTIPLY', b.math('MULTIPLY', ridge, mask), 0.14))
    fine = b.noise(p, 60.0, detail=5, rough=0.6)
    hgt = b.math('ADD', hgt, b.math('MULTIPLY', b.math('SUBTRACT', fine.outputs['Fac'], 0.5), 0.02))
    return hgt


def build_material(mode, sea, seed, storms):
    mat = bpy.data.materials.new('bake_' + mode)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    b = NB(nt)
    p = unit_pos(b)
    out = b.n('ShaderNodeOutputMaterial')
    em = b.n('ShaderNodeEmission')
    b.link(em.outputs[0], out.inputs['Surface'])
    xyz = b.sep(p)
    latr = b.math('ARCSINE', xyz[2])   # radians; Blender Z is the polar axis
    lat = b.math('ABSOLUTE', b.math('MULTIPLY', latr, 2.0 / math.pi))  # 0 equator .. 1 pole

    hg = height_socket(b, p, seed)

    if mode == 'height':
        col = b.n('ShaderNodeCombineColor')
        for i in range(3):
            b.link(hg, col.inputs[i])
        b.link(col.outputs[0], em.inputs['Color'])
        return mat

    e_land = b.math('SUBTRACT', hg, sea)                      # >0 land
    depth = b.math('SUBTRACT', sea, hg)                       # >0 ocean

    # ---------------------------------------------------------- sea ice ---
    jitter = b.noise(p, 5.0, detail=5, rough=0.6, w=seed + 3)
    ice_edge = b.math('ADD', 0.86, b.math('MULTIPLY', b.math('SUBTRACT', jitter.outputs['Fac'], 0.5), 0.14))
    ice = b.smooth(lat, ice_edge, b.math('ADD', ice_edge, 0.05)) if False else None
    ice_t = b.math('SUBTRACT', lat, ice_edge)
    ice = b.math('MINIMUM', b.math('MAXIMUM', b.math('MULTIPLY', ice_t, 30.0), 0.0), 1.0)

    if mode == 'aux':
        land = b.math('GREATER_THAN', e_land, 0.0)
        # City lights: populous clusters on temperate lowland coasts.
        clusters = b.noise(p, 5.5, detail=6, rough=0.62, w=seed + 9)
        pop = b.smooth(clusters.outputs['Fac'], 0.47, 0.62)
        dots = b.noise(p, 210.0, detail=3, rough=0.5, w=seed + 2)
        dotm = b.smooth(dots.outputs['Fac'], 0.56, 0.66)
        # Bright metropolitan cores.
        metro = b.noise(p, 55.0, detail=2, rough=0.5, w=seed + 5)
        metrom = b.smooth(metro.outputs['Fac'], 0.58, 0.70)
        lat_pref = b.math('SUBTRACT', 1.0, b.smooth(lat, 0.55, 0.85))          # fade toward poles
        lowland = b.math('SUBTRACT', 1.0, b.smooth(e_land, 0.05, 0.16))        # no lights on peaks
        base = b.math('MULTIPLY', b.math('MULTIPLY', land, lat_pref), lowland)
        dens = b.math('MULTIPLY', base, pop)
        lights = b.math('MULTIPLY', dens, b.math('ADD', b.math('MULTIPLY', dotm, 0.75), b.math('MULTIPLY', metrom, 0.6)))
        lights = b.math('MULTIPLY', lights, b.math('SUBTRACT', 1.0, ice))
        lights = b.math('ADD', lights, b.math('MULTIPLY', b.math('MULTIPLY', dens, 0.10), b.math('ADD', b.math('MULTIPLY', clusters.outputs['Fac'], 0.0), 1.0)))
        col = b.n('ShaderNodeCombineColor')
        b.link(hg, col.inputs[0])
        b.link(ice, col.inputs[1])
        b.link(b.math('MINIMUM', lights, 1.0), col.inputs[2])
        b.link(col.outputs[0], em.inputs['Color'])
        return mat

    if mode == 'albedo':
        # ---- ocean: depth gradient, turquoise shelves, deep navy basins.
        d = b.math('MINIMUM', b.math('MULTIPLY', depth, 5.5), 1.0)
        d = b.math('POWER', d, 0.6)
        ocean = b.ramp(d, [(0.0, c3('#3fb8b0')), (0.10, c3('#1f86b5')), (0.40, c3('#0f4f88')), (0.75, c3('#082f5c')), (1.0, c3('#041c3d'))])
        swirl = b.noise(p, 14.0, detail=6, rough=0.6, w=seed + 11)
        ocean = b.mix(b.math('MULTIPLY', b.math('SUBTRACT', swirl.outputs['Fac'], 0.5), 0.35), ocean, c3('#12609a'))

        # ---- land biomes
        moist = b.noise(p, 2.6, detail=6, rough=0.55, w=seed + 21)
        moist2 = b.noise(p, 9.0, detail=4, rough=0.5, w=seed + 22)
        m = b.math('ADD', b.math('MULTIPLY', moist.outputs['Fac'], 0.75), b.math('MULTIPLY', moist2.outputs['Fac'], 0.25))
        # Subtropical dry belts around 15-35 degrees latitude.
        belt = b.math('SUBTRACT', 1.0, b.math('MINIMUM', b.math('MULTIPLY', b.math('ABSOLUTE', b.math('SUBTRACT', lat, 0.30)), 4.0), 1.0))
        dryness = b.math('SUBTRACT', b.math('ADD', b.math('SUBTRACT', 1.0, m), b.math('MULTIPLY', belt, 0.55)), 0.55)
        dry = b.smooth(dryness, 0.05, 0.42)
        temp = b.math('SUBTRACT', 1.0, b.math('ADD', b.math('POWER', lat, 1.6), b.math('MULTIPLY', e_land, 1.6)))
        veg_ramp = b.ramp(b.math('MINIMUM', b.math('MAXIMUM', temp, 0.0), 1.0),
                          [(0.0, c3('#8f9a86')), (0.28, c3('#6f8452')), (0.5, c3('#3d6b34')), (0.75, c3('#2b6a2f')), (1.0, c3('#1f5a2a'))])
        tex = b.noise(p, 40.0, detail=6, rough=0.62, w=seed + 31)
        veg = b.mix(b.math('MULTIPLY', b.math('SUBTRACT', tex.outputs['Fac'], 0.5), 0.9), veg_ramp, c3('#557a3a'))
        desert_ramp = b.ramp(tex.outputs['Fac'], [(0.35, c3('#b98f55')), (0.55, c3('#d0aa72')), (0.75, c3('#e3c58e'))])
        land_col = b.mix(dry, veg, desert_ramp)
        # mountains: bare rock then snow
        rock = b.smooth(e_land, 0.12, 0.26)
        rock_col = b.ramp(tex.outputs['Fac'], [(0.3, c3('#5b5148')), (0.6, c3('#7e7466')), (0.9, c3('#9a9082'))])
        land_col = b.mix(rock, land_col, rock_col)
        snow_line = b.math('ADD', 0.30, b.math('MULTIPLY', b.math('SUBTRACT', 1.0, lat), 0.16))
        snow = b.smooth(e_land, snow_line, 0.08)
        land_col = b.mix(snow, land_col, c3('#f4f7fa'))
        # tundra fade at high latitude
        tundra = b.smooth(lat, 0.68, 0.82)
        land_col = b.mix(b.math('MULTIPLY', tundra, 0.6), land_col, c3('#a9a794'))

        is_land = b.math('GREATER_THAN', e_land, 0.0)
        # soft coast so texture filtering doesn't pop
        coast = b.smooth(e_land, -0.004, 0.004)
        col = b.mix(coast, ocean, land_col)
        # sea ice / ice caps override
        ice_col = b.ramp(jitter.outputs['Fac'], [(0.3, c3('#dfe9f2')), (0.7, c3('#f8fbff'))])
        col = b.mix(ice, col, ice_col)
        b.link(col, em.inputs['Color'])
        return mat

    if mode == 'clouds':
        pw = p
        # Storm swirls: rotate sampling coordinates about each storm centre by
        # an angle that peaks at the eye, producing spiral arms in the noise.
        storm_fac = None
        for (lat_d, lon_d, radius, strength) in storms:
            la, lo = math.radians(lat_d), math.radians(lon_d)
            centre = (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))
            dist = b.vmath('DISTANCE', pw, centre)
            fall = b.math('EXPONENT', b.math('MULTIPLY', b.math('MULTIPLY', b.math('DIVIDE', dist, radius), b.math('DIVIDE', dist, radius)), -1.0))
            rot = b.n('ShaderNodeVectorRotate', rotation_type='AXIS_ANGLE')
            rot.inputs['Axis'].default_value = centre
            b.link(pw, rot.inputs['Vector'])
            sgn = 1.0 if la >= 0 else -1.0
            b.link(b.math('MULTIPLY', fall, strength * sgn * 10.0), rot.inputs['Angle'])
            pw = rot.outputs[0]
            sf = b.math('MULTIPLY', fall, 1.0)
            storm_fac = sf if storm_fac is None else b.math('MAXIMUM', storm_fac, sf)
        warp = b.noise(pw, 2.2, detail=3, rough=0.5, w=seed + 41)
        wv = b.vmath('SUBTRACT', warp.outputs['Color'], (0.5, 0.5, 0.5))
        pw2 = b.vmath('ADD', pw, b.vmath('MULTIPLY', wv, (0.55, 0.55, 0.55)))
        # stretch clouds along latitude circles: squash z
        sq = b.sep(pw2)
        comb = b.n('ShaderNodeCombineXYZ')
        b.link(sq[0], comb.inputs[0]); b.link(sq[1], comb.inputs[1])
        b.link(b.math('MULTIPLY', sq[2], 1.9), comb.inputs[2])
        cn = b.noise(comb.outputs[0], 2.6, detail=9, rough=0.58, lac=2.15, w=seed + 43)
        cn2 = b.noise(pw2, 7.5, detail=6, rough=0.55, w=seed + 44)
        dens = b.math('ADD', b.math('MULTIPLY', cn.outputs['Fac'], 0.72), b.math('MULTIPLY', cn2.outputs['Fac'], 0.28))
        # Zonal coverage: ITCZ + mid-latitude storm tracks, clear subtropics.
        zonal = b.math('ADD', 0.5, b.math('MULTIPLY', b.math('COSINE', b.math('MULTIPLY', xyz[2], 9.4)), -0.0))
        latr = b.math('ARCSINE', xyz[2])   # radians
        cov = b.math('ADD', b.math('MULTIPLY', b.math('COSINE', b.math('MULTIPLY', latr, 6.0)), -0.05), 0.0)
        thr = b.math('ADD', 0.47, cov)
        if storm_fac is not None:
            thr = b.math('SUBTRACT', thr, b.math('MULTIPLY', storm_fac, 0.22))
        c = b.smooth(dens, b.math('SUBTRACT', thr, 0.03) if False else 0.0, 1.0) if False else None
        t0 = b.math('SUBTRACT', dens, b.math('SUBTRACT', thr, 0.02))
        c = b.math('MINIMUM', b.math('MAXIMUM', b.math('MULTIPLY', t0, 4.2), 0.0), 1.0)
        c = b.math('MULTIPLY', c, b.math('ADD', 0.72, b.math('MULTIPLY', cn2.outputs['Fac'], 0.5)))
        if storm_fac is not None:
            c = b.math('ADD', c, b.math('MULTIPLY', storm_fac, 0.25))
        c = b.math('MINIMUM', c, 1.0)
        col = b.n('ShaderNodeCombineColor')
        for i in range(3):
            b.link(c, col.inputs[i])
        b.link(col.outputs[0], em.inputs['Color'])
        return mat
    raise ValueError(mode)


# ------------------------------------------------------------------- bake ---
def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 1
    sc.cycles.use_denoising = False
    sc.cycles.bake_type = 'EMIT'
    sc.render.bake.margin = 12
    sc.render.bake.use_clear = True
    sc.view_settings.view_transform = 'Standard'
    bpy.ops.mesh.primitive_uv_sphere_add(segments=256, ring_count=128, radius=1.0)
    obj = bpy.context.active_object
    bpy.ops.object.shade_smooth()
    return obj


def bake(obj, mode, sea, seed, storms):
    mat = build_material(mode, sea, seed, storms)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    img = bpy.data.images.new('img_' + mode, W, H, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = img
    mat.node_tree.nodes.active = tex
    bpy.ops.object.bake(type='EMIT')
    arr = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)[::-1, :, :3]  # top row first
    return arr


def uv_probe(obj):
    """Return dict describing how Blender's UV sphere maps to lon/lat (sanity)."""
    return {'u0.5_dir': 'see README'}


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def sobel_normal(h, strength, sea):
    # Equirect: x-derivative shrinks by cos(lat); scale to preserve slope.
    hh = h.copy()
    hh = np.maximum(hh, sea)  # flat oceans
    lat = (0.5 - (np.arange(H) + 0.5) / H) * math.pi
    cosl = np.maximum(np.cos(lat), 0.05)[:, None]
    dx = (np.roll(hh, -1, 1) - np.roll(hh, 1, 1)) * 0.5
    dy = (np.roll(hh, 1, 0) - np.roll(hh, -1, 0)) * 0.5   # +y = north
    dy[0] = 0; dy[-1] = 0
    dx = dx / cosl
    nx, ny, nz = -dx * strength, -dy * strength, np.ones_like(dx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / ln, ny / ln, nz / ln], -1)


def save_webp(arr01, path, quality, mode='RGB'):
    a = (np.clip(arr01, 0, 1) * 255 + 0.5).astype(np.uint8)
    im = Image.fromarray(a, 'L' if a.ndim == 2 else 'RGB')
    im.save(path, 'WEBP', quality=quality, method=6)
    return os.path.getsize(path)


def down(a, w, h):
    im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
    return np.asarray(im.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'textures', 'earth'))
    ap.add_argument('--seed', type=float, default=7.0)
    ap.add_argument('--ocean', type=float, default=0.708)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    obj = setup_scene()
    seed = args.seed

    # Pass 1: height, then sea level at the requested ocean fraction.
    height = bake(obj, 'height', 0.5, seed, [])[:, :, 0]
    lat = np.abs(np.cos((0.5 - (np.arange(H) + 0.5) / H) * math.pi))[:, None] * np.ones((1, W))
    sea = float(np.quantile(np.repeat(height.ravel(), 1), args.ocean))  # equirect area weighting below
    order = np.argsort(height.ravel()); cw = np.cumsum(lat.ravel()[order]); cw /= cw[-1]
    sea = float(height.ravel()[order][np.searchsorted(cw, args.ocean)])
    print('sea level', sea)

    # Hurricanes (lat, lon deg, radius, strength) and mid-latitude lows.
    storms = [(18, -50, 0.30, 1.0), (-16, 82, 0.28, 1.0), (14, 138, 0.27, 1.0),
              (52, -28, 0.30, 0.8), (-54, 20, 0.34, 0.8), (-48, 140, 0.30, 0.8), (60, 150, 0.26, 0.7)]

    albedo = bake(obj, 'albedo', sea, seed, [])
    aux = bake(obj, 'aux', sea, seed, [])
    clouds = bake(obj, 'clouds', sea, seed, storms)[:, :, 0]

    h = aux[:, :, 0]
    ice = aux[:, :, 1]
    lights = aux[:, :, 2]
    ocean = (h <= sea).astype(np.float32)
    ocean_soft = np.asarray(Image.fromarray((ocean * 255).astype(np.uint8)).filter(__import__('PIL.ImageFilter', fromlist=['x']).GaussianBlur(0.8))).astype(np.float32) / 255
    water = ocean_soft * (1 - ice)

    # ---- assets
    alb = srgb(albedo)
    normal = sobel_normal(h, 26.0, sea)
    normal_rgb = normal * 0.5 + 0.5
    # spec: R = water (glint), G = roughness (ocean smooth, ice glossy, land rough), B = ice
    rough = 0.85 - 0.75 * water + 0.05 * ice
    spec = np.stack([water, rough, ice], -1)
    # night lights: gamma-lift so faint suburbs survive 8-bit + lossy
    night = np.clip(lights, 0, 1) ** 0.8

    files = {}
    files['albedo'] = ('earth_albedo.webp', save_webp(alb, os.path.join(args.out, 'earth_albedo.webp'), 88), [W, H])
    files['normal'] = ('earth_normal.webp', save_webp(normal_rgb, os.path.join(args.out, 'earth_normal.webp'), 90), [W, H])
    files['clouds'] = ('earth_clouds.webp', save_webp(clouds, os.path.join(args.out, 'earth_clouds.webp'), 82), [W, H])
    files['night'] = ('earth_night.webp', save_webp(down(night, 1024, 512), os.path.join(args.out, 'earth_night.webp'), 85), [1024, 512])
    files['spec'] = ('earth_spec.webp', save_webp(down(spec, 1024, 512), os.path.join(args.out, 'earth_spec.webp'), 85), [1024, 512])

    manifest = {
        'generator': 'tools/earth/build_earth.py',
        'blender': bpy.app.version_string,
        'seed': seed, 'seaLevel': sea, 'oceanFraction': args.ocean,
        'mapping': 'equirectangular, +Y up in app space; see src/gfx/earth',
        'files': {k: {'file': v[0], 'bytes': v[1], 'size': v[2]} for k, v in files.items()},
        'totalBytes': sum(v[1] for v in files.values()),
    }
    with open(os.path.join(args.out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
