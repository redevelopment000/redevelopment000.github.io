const statusEl = document.getElementById("status");
const locateBtn = document.getElementById("locateBtn");
const postcodeBtn = document.getElementById("postcodeBtn");

const BLOCKS = [
  {
    name: "1블럭",
    // 개봉2동 모아타운 1구역(개봉동 270-38/271-13 인근) 기준 프로토타입 좌표
    path: [
      [37.491420, 126.853657],
      [37.491621, 126.855207],
      [37.489947, 126.855376],
      [37.489855, 126.853811],
    ],
  },
  {
    name: "2블럭",
    path: [
      [37.491216, 126.852137],
      [37.491357, 126.853607],
      [37.489849, 126.853786],
      [37.489886, 126.852239],
    ],
  },
  {
    name: "3블럭",
    path: [
      [37.491104, 126.850596],
      [37.491218, 126.852084],
      [37.489873, 126.852212],
      [37.489851, 126.850740],
    ],
  },
];

const DEFAULT_CENTER = [37.4889, 126.8550];
const NOMINATIM_CONFIDENT_MATCH_SCORE = 55;
let map;
let marker;

function setStatus(message) {
  statusEl.textContent = message;
}

function getSouthwestAnchor(path) {
  const lats = path.map(([lat]) => lat);
  const lngs = path.map(([, lng]) => lng);
  return [Math.min(...lats) + 0.00006, Math.min(...lngs) + 0.00006];
}

function placeMarker(lat, lng, statusMessage) {
  if (marker) {
    marker.setLatLng([lat, lng]);
  } else {
    marker = L.circleMarker([lat, lng], {
      radius: 7,
      color: "#dc2626",
      weight: 2,
      fillColor: "#ef4444",
      fillOpacity: 0.8,
    }).addTo(map);
  }

  map.panTo([lat, lng]);
  setStatus(statusMessage);
}

function formatSelectedAddressStatus(roadAddress, jibunAddress) {
  return `선택 주소\n도로명주소: ${roadAddress || "없음"}\n지번주소: ${jibunAddress || "없음"}`;
}

function normalizeAddressPart(value) {
  return value?.trim().replace(/\s+/g, " ") || "";
}

function getSearchViewbox() {
  const coordinates = BLOCKS.flatMap((block) => block.path);
  const lats = coordinates.map(([lat]) => lat);
  const lngs = coordinates.map(([, lng]) => lng);
  const padding = 0.01;
  const minLat = Math.min(...lats) - padding;
  const maxLat = Math.max(...lats) + padding;
  const minLng = Math.min(...lngs) - padding;
  const maxLng = Math.max(...lngs) + padding;

  return `${minLng},${minLat},${maxLng},${maxLat}`;
}

function getStructuredStreet(selection) {
  const roadAddress = normalizeAddressPart(selection.roadAddress);
  const fullPrefix = [selection.sido, selection.sigungu].filter(Boolean).join(" ");

  if (fullPrefix && roadAddress.startsWith(`${fullPrefix} `)) {
    return roadAddress.slice(fullPrefix.length + 1).trim();
  }

  if (selection.sido && roadAddress.startsWith(`${selection.sido} `)) {
    return roadAddress.slice(selection.sido.length + 1).trim();
  }

  return roadAddress;
}

function buildNominatimCandidates(selection) {
  const street = getStructuredStreet(selection);
  const locality = normalizeAddressPart(selection.hname || selection.bname);
  const candidates = [];

  if (street) {
    candidates.push({
      street,
      county: selection.sigungu,
      state: selection.sido,
      postalcode: selection.zonecode,
      city: locality,
    });

    candidates.push({
      street,
      county: selection.sigungu,
      state: selection.sido,
      postalcode: selection.zonecode,
    });

    if (locality) {
      candidates.push({
        street,
        city: locality,
        county: selection.sigungu,
        state: selection.sido,
      });
    }
  }

  candidates.push({
    q: selection.roadAddress,
  });

  return candidates;
}

function buildNominatimSearchUrl(params) {
  const searchParams = new URLSearchParams();
  const mergedParams = {
    format: "jsonv2",
    limit: "5",
    countrycodes: "kr",
    "accept-language": "ko",
    addressdetails: "1",
    viewbox: getSearchViewbox(),
    ...params,
  };

  Object.entries(mergedParams).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });

  return `https://nominatim.openstreetmap.org/search?${searchParams.toString()}`;
}

function scoreNominatimResult(result, selection) {
  const address = result.address || {};
  const searchableText = [
    result.display_name,
    address.road,
    address.house_number,
    address.neighbourhood,
    address.suburb,
    address.quarter,
    address.city_district,
    address.city,
    address.town,
    address.village,
    address.county,
    address.state,
    address.postcode,
  ]
    .filter(Boolean)
    .join(" ");

  const locality = normalizeAddressPart(selection.hname || selection.bname);
  let score = Math.min(Number(result.place_rank) || 0, 30);

  if (selection.zonecode && address.postcode === selection.zonecode) score += 35;
  if (selection.roadname && searchableText.includes(selection.roadname)) score += 25;
  if (selection.sigungu && searchableText.includes(selection.sigungu)) score += 15;
  if (selection.sido && searchableText.includes(selection.sido)) score += 10;
  if (locality && searchableText.includes(locality)) score += 15;
  if (selection.roadAddress && result.display_name?.includes(selection.roadAddress)) score += 20;
  if (["building", "house", "residential"].includes(result.type)) score += 15;
  if (["building", "place", "boundary", "highway"].includes(result.class)) score += 5;

  return score;
}

async function searchNominatim(params) {
  const response = await fetch(buildNominatimSearchUrl(params), {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`주소 변환 요청 실패 (${response.status})`);
  }

  return response.json();
}

function drawBlocks() {
  BLOCKS.forEach((block) => {
    L.polygon(block.path, {
      color: "#D69E00",
      weight: 2,
      fillColor: "#FFD54A",
      fillOpacity: 0.35,
    }).addTo(map);

    const labelPos = getSouthwestAnchor(block.path);
    L.marker(labelPos, {
      interactive: false,
      icon: L.divIcon({
        className: "block-label-wrap",
        html: `<span class="block-label">${block.name}</span>`,
      }),
    }).addTo(map);
  });
}

function initMap() {
  map = L.map("map", {
    center: DEFAULT_CENTER,
    zoom: 17,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  drawBlocks();
  setStatus("지도 준비 완료. 현위치 버튼 또는 다음 주소찾기를 이용하세요.");
}

async function geocodeAddress(selection) {
  const candidates = buildNominatimCandidates(selection);
  let bestMatch = null;

  for (const candidate of candidates) {
    const results = await searchNominatim(candidate);
    if (!results.length) continue;

    const ranked = results
      .map((result) => ({
        result,
        score: scoreNominatimResult(result, selection),
      }))
      .sort((left, right) => right.score - left.score)[0];

    if (!bestMatch || ranked.score > bestMatch.score) {
      bestMatch = ranked;
    }

    if (ranked.score >= NOMINATIM_CONFIDENT_MATCH_SCORE) {
      return {
        lat: Number(ranked.result.lat),
        lng: Number(ranked.result.lon),
      };
    }
  }

  if (bestMatch) {
    return {
      lat: Number(bestMatch.result.lat),
      lng: Number(bestMatch.result.lon),
    };
  }

  throw new Error("주소 검색 결과가 없습니다.");
}

async function handleAddressSearch(selection, statusMessage) {
  try {
    setStatus("Nominatim 구조화 검색으로 주소를 좌표로 변환 중...");
    const { lat, lng } = await geocodeAddress(selection);
    placeMarker(lat, lng, statusMessage);
  } catch (error) {
    setStatus(`주소 검색 실패: ${error.message}`);
  }
}

function openDaumPostcode() {
  if (!window.daum?.Postcode) {
    setStatus("다음 우편번호 서비스를 불러오지 못했습니다.");
    return;
  }

  new window.daum.Postcode({
    oncomplete(data) {
      const selection = {
        roadAddress: normalizeAddressPart(data.roadAddress),
        jibunAddress: normalizeAddressPart(data.jibunAddress),
        zonecode: normalizeAddressPart(data.zonecode),
        sido: normalizeAddressPart(data.sido),
        sigungu: normalizeAddressPart(data.sigungu),
        bname: normalizeAddressPart(data.bname),
        hname: normalizeAddressPart(data.hname),
        roadname: normalizeAddressPart(data.roadname),
      };

      if (!selection.roadAddress) {
        setStatus(`선택한 결과에 도로명주소가 없습니다.\n지번주소: ${selection.jibunAddress || "없음"}`);
        return;
      }

      handleAddressSearch(
        selection,
        formatSelectedAddressStatus(selection.roadAddress, selection.jibunAddress)
      );
    },
  }).open();
}

function locateCurrentPosition() {
  if (!navigator.geolocation) {
    setStatus("이 브라우저는 Geolocation API를 지원하지 않습니다.");
    return;
  }

  setStatus("현위치 확인 중... (GPS/와이파이/통신망 정보 기반)");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      placeMarker(position.coords.latitude, position.coords.longitude, "현위치를 지도에 표시했습니다.");
    },
    (error) => {
      setStatus(`현위치 조회 실패: ${error.message}`);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    }
  );
}

initMap();

locateBtn.addEventListener("click", locateCurrentPosition);
postcodeBtn.addEventListener("click", openDaumPostcode);
