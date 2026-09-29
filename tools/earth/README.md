# Earth map generator (Blender)

`build_earth.py` runs Blender headless (the `bpy` 4.2 Python module, Cycles
CPU baking) and writes `public/textures/earth/*.webp` + `manifest.json`.

```
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python bpy==4.2.0 numpy pillow
.venv/bin/python tools/earth/build_earth.py        # ~1 min
```

What Blender bakes (2048x1024 equirect, on a UV sphere, EMIT bake of shader
node graphs; seamless because the graphs use object-space direction):
1. height: domain-warped fBm continents + ridged mountains; sea level is then
   set at the 70.8 % ocean area quantile.
2. albedo: ocean depth gradient, shelves, biomes (rainforest/desert belts/
   tundra/rock/snowline), polar sea ice.
3. aux: city-light density (clustered on temperate lowland), ice mask.
4. clouds: warped fBm with zonal coverage and 7 storm swirls (vector-rotate).

numpy/Pillow derive the tangent-space normal map, spec/roughness
(R water, G roughness, B ice) and encode WebP (~0.6 MB total).

Mapping: u = 0.5 + atan2(-z, x)/2pi, v = 0.5 + asin(y)/pi (app space, +Y up,
flipY textures). `--seed` changes the world.
