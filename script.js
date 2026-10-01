const map = L.map('map', { scrollWheelZoom: false, zoomSnap: 0.25 }).setView([59.913, 10.75], 11);
const priceBands = Array.from({ length: 11 }, (_, index) => ({
    min: 20000 + index * 10000,
    max: 30000 + index * 10000,
    color: ['#f3eef9', '#e8dcf3', '#dac5eb', '#c9a9df', '#b58bd2', '#a06ec3', '#8952b2', '#743f9d', '#603186', '#4b246b', '#35184f'][index]
}));
const displayYear = '2025';
const legend = document.querySelector('#legend');
const status = document.querySelector('#map-status');
const numberFormat = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 });
const percentFormat = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 1, signDisplay: 'always' });

function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const crosses = (yi > y) !== (yj > y)
            && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

        if (crosses) inside = !inside;
    }

    return inside;
}

function ringArea(ring) {
    return Math.abs(ring.reduce((sum, point, index) => {
        const next = ring[(index + 1) % ring.length];
        return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2);
}

function labelPosition(feature) {
    const largestRing = feature.geometry.coordinates
        .map((polygon) => polygon[0])
        .sort((a, b) => ringArea(b) - ringArea(a))[0];
    let areaTwice = 0;
    let centerX = 0;
    let centerY = 0;

    largestRing.forEach((point, index) => {
        const next = largestRing[(index + 1) % largestRing.length];
        const cross = point[0] * next[1] - next[0] * point[1];
        areaTwice += cross;
        centerX += (point[0] + next[0]) * cross;
        centerY += (point[1] + next[1]) * cross;
    });

    if (areaTwice !== 0) {
        const centroid = [centerX / (3 * areaTwice), centerY / (3 * areaTwice)];
        if (pointInRing(centroid, largestRing)) return centroid;
    }

    const longitudes = largestRing.map((point) => point[0]);
    const latitudes = largestRing.map((point) => point[1]);
    const minX = Math.min(...longitudes);
    const maxX = Math.max(...longitudes);
    const minY = Math.min(...latitudes);
    const maxY = Math.max(...latitudes);
    let bestPoint = [minX + (maxX - minX) / 2, minY + (maxY - minY) / 2];
    let widestSpan = 0;

    for (let step = 1; step < 20; step += 1) {
        const y = minY + ((maxY - minY) * step) / 20;
        const intersections = [];

        for (let index = 0; index < largestRing.length; index += 1) {
            const point = largestRing[index];
            const next = largestRing[(index + 1) % largestRing.length];
            if ((point[1] > y) !== (next[1] > y)) {
                intersections.push(point[0] + ((y - point[1]) * (next[0] - point[0])) / (next[1] - point[1]));
            }
        }

        intersections.sort((a, b) => a - b);
        for (let index = 0; index < intersections.length - 1; index += 2) {
            const span = intersections[index + 1] - intersections[index];
            if (span > widestSpan) {
                widestSpan = span;
                bestPoint = [intersections[index] + span / 2, y];
            }
        }
    }

    return bestPoint;
}

function ringsToPolygons(rings) {
    const sorted = rings
        .filter((ring) => ring.length >= 4)
        .map((ring) => ({ ring, area: ringArea(ring), parent: null, depth: 0 }))
        .sort((a, b) => b.area - a.area);

    sorted.forEach((item, index) => {
        const containers = sorted.slice(0, index)
            .filter((candidate) => pointInRing(item.ring[0], candidate.ring))
            .sort((a, b) => a.area - b.area);
        item.parent = containers[0] ?? null;
        item.depth = item.parent ? item.parent.depth + 1 : 0;
    });

    return sorted
        .filter((item) => item.depth % 2 === 0)
        .map((outer) => [
            outer.ring,
            ...sorted
                .filter((item) => item.parent === outer && item.depth % 2 === 1)
                .map((item) => item.ring)
        ]);
}

function toGeoJSON(boundaryData) {
    return {
        type: 'FeatureCollection',
        features: boundaryData.features.map((feature) => ({
            type: 'Feature',
            properties: feature.attributes,
            geometry: {
                type: 'MultiPolygon',
                coordinates: ringsToPolygons(feature.geometry.rings)
            }
        }))
    };
}

function buildPriceLookup(statistics) {
    const years = statistics.dimension['år'].category.label;
    const geographies = statistics.dimension.geografi.category;
    const yearCodes = Object.keys(years).sort((a, b) => years[a] - years[b]);
    const geographyCodes = Object.keys(geographies.label)
        .sort((a, b) => geographies.index[a] - geographies.index[b]);
    const prices = new Map();

    yearCodes.forEach((yearCode, yearIndex) => {
        geographyCodes.forEach((geographyCode, geographyIndex) => {
            prices.set(`${geographyCode}-${years[yearCode]}`,
                statistics.value[yearIndex * geographyCodes.length + geographyIndex]);
        });
    });

    return { years: yearCodes.map((code) => years[code]), geographyLabels: geographies.label, prices };
}

function formatPrice(value) {
    if (value == null || !Number.isFinite(value)) return 'Ingen data';
    return `${numberFormat.format(value)} kr/m²`;
}

function formatChange(currentPrice, basePrice) {
    if (currentPrice == null || basePrice == null || !Number.isFinite(currentPrice) || !Number.isFinite(basePrice) || basePrice === 0) {
        return 'Ingen data';
    }
    return `${percentFormat.format(((currentPrice / basePrice) - 1) * 100)} %`;
}

function valueForFeature(feature) {
    const geographyCode = `301${String(feature.properties.BYDELNR).padStart(2, '0')}`;
    return priceData.prices.get(`${geographyCode}-${displayYear}`) ?? null;
}

function colorForValue(value) {
    if (value == null) return '#cbd3d8';
    const band = priceBands.find((priceBand) => value < priceBand.max);
    return (band || priceBands.at(-1)).color;
}

function popupContent(feature) {
    const geographyCode = `301${String(feature.properties.BYDELNR).padStart(2, '0')}`;
    const basePrice = priceData.prices.get(`${geographyCode}-2018`);
    const currentPrice = priceData.prices.get(`${geographyCode}-${displayYear}`);

    return `<div class="popup-title">${feature.properties.BYDELSNAVN}</div>`
        + `<div>2018: <strong>${formatPrice(basePrice)}</strong></div>`
        + `<div>${displayYear}: <strong>${formatPrice(currentPrice)}</strong></div>`
        + `<div>Stigning 2018–${displayYear}: <strong>${formatChange(currentPrice, basePrice)}</strong></div>`;
}

function refreshMap() {
    const values = boundaryLayer.getLayers()
        .map((layer) => valueForFeature(layer.feature))
        .filter((value) => value != null);
    const title = `Pris per m² · ${displayYear}`;

    boundaryLayer.setStyle((feature) => ({
        color: '#fff',
        weight: 1.4,
        opacity: 1,
        fillColor: colorForValue(valueForFeature(feature)),
        fillOpacity: 0.82
    }));

    legend.innerHTML = `<span class="legend-title">${title}</span>` + priceBands.map((band) => {
        const lowerLabel = numberFormat.format(band.min);
        const upperLabel = numberFormat.format(band.max);
        return `<span class="legend-item"><i class="legend-swatch" style="background:${band.color}"></i>${lowerLabel}–${upperLabel} kr/m²</span>`;
    }).join('');

    status.textContent = `${values.length} bydeler · klikk på en bydel for detaljer`;
}

let priceData;
let boundaryLayer;

async function loadMapData() {
    try {
        const [boundaryResponse, statisticsResponse] = await Promise.all([
            fetch('./bydeler.json'),
            fetch('./stat2.json')
        ]);
        if (!boundaryResponse.ok || !statisticsResponse.ok) {
            throw new Error('JSON-filene kunne ikke lastes.');
        }

        const [boundaryData, statistics] = await Promise.all([
            boundaryResponse.json(),
            statisticsResponse.json()
        ]);
        priceData = buildPriceLookup(statistics);

        const boroughGeoJSON = toGeoJSON(boundaryData);
        boroughGeoJSON.features = boroughGeoJSON.features.filter((feature) => {
            const geographyCode = `301${String(feature.properties.BYDELNR).padStart(2, '0')}`;
            return priceData.prices.has(`${geographyCode}-2018`);
        });

        boundaryLayer = L.geoJSON(boroughGeoJSON, {
            style: { color: '#fff', weight: 1.4, fillOpacity: 0.82 },
            onEachFeature: (feature, layer) => {
                const [longitude, latitude] = labelPosition(feature);
                const labelOffsets = {
                    'Grünerløkka': L.point(28, 10),
                    'Sentrum': L.point(10, -14)
                };
                layer.bindTooltip(feature.properties.BYDELSNAVN, {
                    permanent: true,
                    direction: 'center',
                    offset: labelOffsets[feature.properties.BYDELSNAVN] || L.point(0, 0),
                    className: 'district-label'
                });
                layer.openTooltip([latitude, longitude]);
                layer.bindPopup(() => popupContent(feature));
            }
        }).addTo(map);

        const boroughBounds = boundaryLayer.getBounds();
        map.fitBounds(boroughBounds, { padding: [0, 0], maxZoom: 12 });
        map.setMaxBounds(boroughBounds.pad(0.02));
        refreshMap();
    } catch (error) {
        console.error(error);
        status.textContent = 'Kunne ikke laste data. Åpne siden via en lokal webserver.';
    }
}

loadMapData();
