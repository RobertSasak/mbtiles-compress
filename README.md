# mbtiles-compress

A Node.js command line tool for compressing raster MBTiles files using WebP compression.

## Installation

```bash
npm install -g mbtiles-compress
```

or run without installing

```bash
npx mbtiles-compress
```

## Usage

```bash
mbtiles-compress [options] <source.mbtiles> <destination.mbtiles>
```

### Options

```bash
Usage: mbtiles-compress [options] <source> <destination>

Compress MBTiles files using WebP compression

Arguments:
  source                        Path to source MBTiles file
  destination                   Path to output compressed MBTiles file

Options:
  -q, --quality <number>        WebP compression quality (0-100) (default: "75")
  -a, --alpha-quality <number>  WebP alpha quality (0-100, default: 100) (default: "100")
  -m, --method <number>         WebP compression method (0-6, default: 4) (default: "4")
  -c, --concurrency <number>    Number of parallel compression operations (default: "20")
  -f, --force                   Overwrite destination if it exists (default: false)
  -s, --skip-count              Skip counting rows before compression (default: false)
  -h, --help                    display help for command
```

### Examples

```bash
# Basic compression with default quality
npx mbtiles-compress input.mbtiles output.mbtiles

# Compression with custom quality
npx mbtiles-compress input.mbtiles output.mbtiles --quality 60

# High concurrency for faster processing
npx mbtiles-compress input.mbtiles output.mbtiles -c 100

# Maximum compression method
npx mbtiles-compress input.mbtiles output.mbtiles -m 6
```

### WebP Parameters

- **Quality (0-100)**: Controls the overall image quality. Higher values = better quality but larger files
- **Alpha Quality (0-100)**: Controls the quality of alpha channel (transparency). 0 = lossy alpha, 100 = lossless alpha
- **Method (0-6)**: Compression method/speed tradeoff. 0 = fastest compression, 6 = best compression (slowest)

## Performance

Under the hood, this tool uses the `sharp` library. In addition to concurrency, also `UV_THREADPOOL_SIZE` environment variable can be set to get the best performance. See [sharp's documentation](https://sharp.pixelplumbing.com/performance) for more details.

```bash
UV_THREADPOOL_SIZE=64 npx mbtiles-compress input.mbtiles output.mbtiles -c 100
```
