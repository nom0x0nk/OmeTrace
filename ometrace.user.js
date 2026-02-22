// ==UserScript==
// @name         OmeTrace
// @version      1.0
// @description  Captures IP, location, and attempts gender detection on Ome.tv safely
// @match        https://ome.tv/*
// @grant        unsafeWindow
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

if (window.__OME_OVERLAY_LOADED__) return;
window.__OME_OVERLAY_LOADED__ = true;

(function () {
    'use strict';

    // --- CONFIGURATION & CONSTANTS ---
    const IPINFO_API_KEY = "REPLACE_WITH_YOUR_IPINFO_API_KEY";      // get on https://ipinfo.io/dashboard | looks like c8d4712fa90b63
    const GEOAPIFY_API_KEY = "REPLACE_WITH_YOUR_GEOAPIFY_API_KEY";  // get on https://myprojects.geoapify.com -> select Project -> API Keys | looks like 3f8a1c7d9b2e4f6a5c8d1b7e3f2a9c40

    const MAP_WIDTH = 300;
    const MAP_HEIGHT = 220;
    const MAP_DISPLAY_HEIGHT = 180;
    const MAP_WATERMARK_HEIGHT = 25;

    const IPINFO_CACHE_KEY = 'ometrace_ipinfo_cache_v1';
    const IPINFO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

    // Generate a random prefix for IDs and class names
    const randomPrefix = Math.random().toString(36).substring(2, 10);

    let ipinfoCache = {};
    try { const raw = localStorage.getItem(IPINFO_CACHE_KEY); if (raw) ipinfoCache = JSON.parse(raw); } catch (e) { ipinfoCache = {}; }
    function saveIpinfoCache() { try { localStorage.setItem(IPINFO_CACHE_KEY, JSON.stringify(ipinfoCache)); } catch (e) { } }

    let isStreamerMode = false;
    let areModelsLoaded = false;
    let lastCapturedIP = null;
    let isProcessingIP = false;
    let showFaceBoxes = false;

    const window = unsafeWindow;

    // --- WEBRTC HOOK TO CAPTURE IP ---
    window.oRTCPeerConnection = window.oRTCPeerConnection || window.RTCPeerConnection;

    window.RTCPeerConnection = function (...args) {
        const pc = new window.oRTCPeerConnection(...args);

        pc.oAddIceCandidate = pc.addIceCandidate;

        pc.addIceCandidate = function (iceCandidate, ...rest) {
            if (iceCandidate && iceCandidate.candidate) {
                const fields = iceCandidate.candidate.split(" ");
                if (fields.length > 7 && fields[7] === "srflx") {
                    const ip = fields[4];
                    if (ip && ip !== lastCapturedIP && !isProcessingIP) {
                        lastCapturedIP = ip;
                        console.log("[OmeTrace] IP Captured:", ip);
                        gatherIPInfo(ip);
                    }
                }
            }
            return pc.oAddIceCandidate(iceCandidate, ...rest);
        };

        return pc;
    };

    window.RTCPeerConnection.prototype = window.oRTCPeerConnection.prototype;

    // --- GENDER DETECTION ---
    let activeVideo = null;
    let detectionInterval = null;
    let currentCanvas = null;
    let missCounter = 0;

    function waitForVideo() {
        setInterval(() => {
            const video = document.querySelector("video");
            if (!video || !areModelsLoaded) return;
            if (video !== activeVideo) {
                activeVideo = video;
                startDetection(video);
            }
        }, 1000);
    }

    function startDetection(video) {
        if (detectionInterval) clearInterval(detectionInterval);
        detectionInterval = setInterval(async () => {
            if (!video || video.readyState < 2 || video.videoWidth === 0) {
                clearCanvas();
                return;
            }
            try {
                const detection = await window.faceapi
                    .detectSingleFace(video, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }))
                    .withAgeAndGender();

                if (!detection) {
                    missCounter++;
                    if (missCounter >= 3) {
                        removeGenderFromOverlay();
                        clearCanvas();
                    }
                    return;
                }

                missCounter = 0;
                drawBox(video, detection);
                updateGenderOverlay(detection);
            } catch (err) {
                console.log("[OmeTrace] Detection error:", err);
            }
        }, 1200);
    }

    function drawBox(video, detection) {
        if (!video.parentElement) return;
        if (!showFaceBoxes) { clearCanvas(); return; }

        const rect = video.getBoundingClientRect();
        if (!currentCanvas) {
            currentCanvas = document.createElement("canvas");
            currentCanvas.style.position = "absolute";
            currentCanvas.style.pointerEvents = "none";
            currentCanvas.style.zIndex = "999";
            video.parentElement.style.position = "relative";
            video.parentElement.appendChild(currentCanvas);
        }

        currentCanvas.width = rect.width;
        currentCanvas.height = rect.height;
        currentCanvas.style.width = rect.width + "px";
        currentCanvas.style.height = rect.height + "px";
        currentCanvas.style.top = video.offsetTop + "px";
        currentCanvas.style.left = video.offsetLeft + "px";

        const displaySize = { width: rect.width, height: rect.height };
        window.faceapi.matchDimensions(currentCanvas, displaySize);
        const resized = window.faceapi.resizeResults(detection, displaySize);

        const ctx = currentCanvas.getContext("2d");
        ctx.clearRect(0, 0, currentCanvas.width, currentCanvas.height);
        const box = resized.detection.box;
        ctx.strokeStyle = detection.gender === "female" ? "#ff4da6" : "#3399ff";
        ctx.lineWidth = 3;
        ctx.strokeRect(box.x, box.y, box.width, box.height);
        ctx.font = "16px Arial";
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(`${detection.gender} (${Math.round(detection.age)})`, box.x, box.y - 8);
    }

    function clearCanvas() {
        if (!currentCanvas) return;
        const ctx = currentCanvas.getContext("2d");
        ctx.clearRect(0, 0, currentCanvas.width, currentCanvas.height);
    }

    function updateGenderOverlay(detection) {
        const infoElement = document.getElementById(randomPrefix + "_Info");
        if (!infoElement) return;

        let genderSpan = infoElement.querySelector('.gender-result');
        if (!genderSpan) {
            genderSpan = document.createElement('span');
            genderSpan.className = 'gender-result';
            genderSpan.style.color = "#ff9f43";
            infoElement.appendChild(genderSpan);
        }

        const genderProb = Math.round(detection.genderProbability * 100);
        genderSpan.innerHTML = `<br><i class="fa-solid fa-user"></i> ${detection.gender} (${Math.round(detection.age)}) ${genderProb}%`;
    }

    function removeGenderFromOverlay() {
        const infoElement = document.getElementById(randomPrefix + "_Info");
        if (!infoElement) return;
        const genderSpan = infoElement.querySelector('.gender-result');
        if (genderSpan) genderSpan.remove();
    }

    // --- IP INFO FETCHING ---
    async function gatherIPInfo(ip) {
        if (isProcessingIP) return;
        isProcessingIP = true;

        updateOverlayHTML(`<i class="fa-solid fa-spinner fa-spin"></i><span>Resolving ${ip}...</span>`);

        const cached = ipinfoCache[ip];
        if (cached && (Date.now() - cached.ts) < IPINFO_CACHE_TTL) {
            console.log("[OmeTrace] Using cached data for:", ip);
            await processIpInfo(cached.data);
            isProcessingIP = false;
            return;
        }

        try {
            const url = `https://ipinfo.io/${ip}/json?token=${IPINFO_API_KEY}`;
            const response = await fetch(url);
            const json = await response.json();

            if (!json.status) {
                console.log("[OmeTrace] Fetched new data for:", ip);
                ipinfoCache[ip] = { ts: Date.now(), data: json };
                saveIpinfoCache();
                await processIpInfo(json);
            } else {
                throw new Error(`API Error: ${json.error || json.status}`);
            }
        } catch (error) {
            console.error("[OmeTrace] Fetch error:", error);
            updateOverlayHTML(`<i class="fa-solid fa-circle-xmark"></i><span>Error fetching IP info</span>`);
        } finally {
            isProcessingIP = false;
        }
    }

    async function processIpInfo(json) {
        let contentHTML = "";
        let mapImageUrl = "";
        let location = json.loc || null;

        let ipValue = isStreamerMode ? 'REDACTED' : (json.ip || 'N/A');
        let country = json.country || 'N/A';
        let city = json.city || 'N/A';
        let region = json.region || 'N/A';
        let org = json.org || 'N/A';

        contentHTML = `
        <i class="fa-solid fa-earth-americas"></i><span>${country}</span><br>
        <i class="fa-solid fa-city"></i><span>${city}</span><br>
        <i class="fa-solid fa-signs-post"></i><span>${region}</span><br>
        <i class="fa-solid fa-ethernet"></i><span>${org}</span><br>
        <i class="fa-solid fa-location-dot"></i><span>${ipValue}</span>`;

        if (location) {
            const [lat, lon] = location.split(',');
            try {
                mapImageUrl = await fetchMapImage(lat, lon);
            } catch (e) {
                console.error("[OmeTrace] Map fetch failed", e);
                mapImageUrl = null;
            }
        }

        // Pass location data. Note: We pass mapUrl regardless of streamer mode now
        updateOverlayHTML(contentHTML, mapImageUrl, location);
    }
async function fetchMapImage(lat, lon) {
    const mapUrl = `https://maps.geoapify.com/v1/staticmap?style=osm-bright&width=${MAP_WIDTH}&height=${MAP_HEIGHT}&center=lonlat:${lon},${lat}&zoom=12&marker=lonlat:${lon},${lat};color:%23ff0000;size:medium&apiKey=${GEOAPIFY_API_KEY}`;

    // Fetch the image as a blob
    const response = await fetch(mapUrl);
    if (!response.ok) throw new Error('Failed to fetch map image');

    const imgBlob = await response.blob();
    const img = new Image();
    const imgURL = URL.createObjectURL(imgBlob);

    return new Promise((resolve, reject) => {
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Define the dimensions of the image and the crop
            const imageWidth = MAP_WIDTH;
            const imageHeight = MAP_HEIGHT;
            const cropHeight = imageHeight - 35;  // Crop the bottom 30px

            // Crop the image by drawing it on the canvas
            canvas.width = imageWidth;
            canvas.height = cropHeight;

            ctx.drawImage(img, 0, 0, imageWidth, cropHeight, 0, 0, canvas.width, canvas.height);

            const croppedImageUrl = canvas.toDataURL(); // Get the base64 encoded image
            resolve(croppedImageUrl);  // Resolve with the cropped image URL
        };

        img.onerror = (e) => reject('Image load error: ' + e);

        img.src = imgURL; // Start loading the image
    });
}

    // --- UI UPDATE LOGIC ---
    function updateOverlayHTML(content, mapUrl = null, location = null) {
        let existingOverlay = document.getElementById(randomPrefix + '_overlay');

        if (!existingOverlay) {
            createBaseOverlay();
            existingOverlay = document.getElementById(randomPrefix + '_overlay');
        }

        // 1. Update IP Text
        let ipInfoDiv = document.getElementById(randomPrefix + '_IPInfo');

        if (!ipInfoDiv) {
            ipInfoDiv = document.createElement('div');
            ipInfoDiv.id = randomPrefix + '_IPInfo';
            const infoP = document.getElementById(randomPrefix + '_Info');
            if (infoP) infoP.insertBefore(ipInfoDiv, infoP.firstChild);
        }

        if (content) ipInfoDiv.innerHTML = content;

        // 2. Update Map
        let mapWrapper = existingOverlay.querySelector('.map-wrapper');

        if (!mapWrapper) {
            mapWrapper = document.createElement('div');
            mapWrapper.className = 'map-wrapper';
            mapWrapper.style.cssText = `
            display: none; /* Start hidden */
        `;
            existingOverlay.appendChild(mapWrapper);
        }

        // If there's a map URL, show the map and set the image source
        if (mapUrl && location) {
            let mapImg = mapWrapper.querySelector('img');
            if (!mapImg) {
                mapImg = document.createElement('img');
                mapWrapper.appendChild(mapImg);
            }

            mapImg.src = mapUrl;

            const [lat, lon] = location.split(',');
            mapWrapper.onclick = () => window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=12/${lat}/${lon}`, '_blank');

            // Show the map
            mapWrapper.style.display = 'block';
        } else {
            // If no map, keep it hidden
            mapWrapper.style.display = 'none';
        }
    }

    function createBaseOverlay() {
        const overlay = document.createElement('div');
        overlay.id = randomPrefix + '_overlay';

        // Info section
        const infoParagraph = document.createElement('p');
        infoParagraph.id = randomPrefix + '_Info';

        const ipInfoDiv = document.createElement('div');
        ipInfoDiv.id = randomPrefix + '_IPInfo';
        ipInfoDiv.innerHTML = '<i class="fa-solid fa-circle-check"></i><span>Ready. Waiting for connection...</span>';

        infoParagraph.appendChild(ipInfoDiv);

        // Map section
        const mapWrapper = document.createElement('div');
        mapWrapper.className = 'map-wrapper';
        mapWrapper.style.cssText = `
        display: none; /* Ensure map is hidden initially */
    `;

        // Buttons container
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'button-container';

        const mapButton = document.createElement('div');
        mapButton.className = 'overlay-button map';
        mapButton.textContent = 'Map';

        const faceBoxesToggleButton = document.createElement('div');
        faceBoxesToggleButton.className = 'overlay-button faceboxes';
        faceBoxesToggleButton.textContent = 'Face Boxes';
        faceBoxesToggleButton.onclick = window.toggleFaceBoxes;

        const streamerToggleButton = document.createElement('div');
        streamerToggleButton.className = 'overlay-button streamer';
        streamerToggleButton.textContent = 'Streamer Mode';
        streamerToggleButton.onclick = window.streamerMode;

        // Append map first, then the buttons
        overlay.appendChild(infoParagraph);    // Append Info
        overlay.appendChild(mapWrapper);      // Append Map above the buttons
        overlay.appendChild(buttonsContainer); // Append Buttons last

        // Add map button to the buttons container
        buttonsContainer.appendChild(mapButton);
        buttonsContainer.appendChild(faceBoxesToggleButton);
        buttonsContainer.appendChild(streamerToggleButton);

        document.body.appendChild(overlay);
    }

    // --- TOGGLES ---
    window.streamerMode = function () {
        isStreamerMode = !isStreamerMode;
        const btn = document.querySelector('.streamer');
        if (btn) {
            btn.style.color = isStreamerMode ? '#00ff00' : '#fff';
            btn.style.borderColor = isStreamerMode ? 'rgba(0, 255, 0, 0.6)' : 'rgba(0, 217, 255, 0.3)';
        }
        // Refresh data if exists to update the 'REDACTED' text
        if (lastCapturedIP && ipinfoCache[lastCapturedIP]) processIpInfo(ipinfoCache[lastCapturedIP].data);
    };

    window.toggleFaceBoxes = function () {
        showFaceBoxes = !showFaceBoxes;
        const btn = document.querySelector('.faceboxes');
        if (btn) {
            btn.style.color = showFaceBoxes ? '#00ff00' : '#fff';
            btn.style.borderColor = showFaceBoxes ? 'rgba(0, 255, 0, 0.6)' : 'rgba(0, 217, 255, 0.3)';
        }
        if (!showFaceBoxes) clearCanvas();
    };

    // --- INITIALIZATION ---
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById(randomPrefix + '_overlay')) return;

        const faceApiScript = document.createElement("script");
        faceApiScript.src = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
        document.head.appendChild(faceApiScript);
        faceApiScript.onload = async () => {
            try {
                const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';
                await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
                await window.faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);
                await window.faceapi.nets.ageGenderNet.loadFromUri(MODEL_URL);
                areModelsLoaded = true;
                waitForVideo();
            } catch (e) { console.error("Face API failed", e); }
        };

        const fontAwesomeLink = document.createElement("link");
        fontAwesomeLink.rel = "stylesheet";
        fontAwesomeLink.href = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css";
        document.head.appendChild(fontAwesomeLink);

        const style = document.createElement('style');
        style.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=Ubuntu&display=swap');
            #${randomPrefix}_overlay {
                position: fixed;
                z-index: 9999;
                background-color: rgba(17, 24, 39, 0.95);
                box-shadow: 0px 0px 20px rgba(0, 217, 255, 0.2);
                border: 1px solid rgba(0, 217, 255, 0.4);
                padding: 15px 25px;
                bottom: 1.5em;
                right: 1.5em;
                border-radius: 12px;
                transition: all 0.3s ease;
                color: #fff;
                max-width: 250px;
                font-family: 'Ubuntu', sans-serif;
            }

            #${randomPrefix}_overlay p#${randomPrefix}_Info {
                font-size: 14px;
                text-align: center;
                color: #fff;
                padding-bottom: 15px;
                user-select: none;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 5px;
                margin: 0;
            }

            #${randomPrefix}_IPInfo {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 5px;
                margin-bottom: 5px;
            }

            #${randomPrefix}_overlay p#${randomPrefix}_Info span {
                color: #00d6fe;
                user-select: all;
            }

            #${randomPrefix}_overlay p#${randomPrefix}_Info i {
                margin-right: 5px;
                width: 15px;
            }

            .overlay-button {
                display: inline-block;
                user-select: none;
                cursor: pointer;
                font-family: 'Ubuntu', sans-serif;
                font-size: 13px;
                border-radius: 6px;
                padding: 8px 16px;
                color: #fff;
                background-color: rgba(0, 217, 255, 0.15);
                border: 1px solid rgba(0, 217, 255, 0.3);
                transition: all 0.2s ease;
            }

            .overlay-button:hover {
                background-color: rgba(0, 217, 255, 0.25);
                transform: translateY(-1px);
            }

            .button-container {
                display: flex;
                justify-content: center;
                flex-wrap: wrap;
                gap: 8px;
                margin-bottom: 8px;
            }

            .map-wrapper {
                margin-bottom: 10px;
                width: 100%;
                height: 154px; /* Ensure no space below */
                overflow: hidden;
                border-radius: 6px;
                border: 1px solid rgba(0, 217, 255, 0.3);
                cursor: pointer;
                position: relative;
            }

            .map-wrapper img {
                width: 100%;
                height: auto; /* Maintain aspect ratio */
                max-height: 100%; /* Ensure image does not overflow */
                object-fit: cover; /* Preserve aspect ratio */
                position: absolute;
                top: 0;
                left: 0;
            }

            .gender-result {
                margin-top: 5px;
                display: block;
            }
            `;
        document.head.appendChild(style);

        createBaseOverlay();
    });

})();
