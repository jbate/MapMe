const apiURL = location.hostname === "localhost" ? "http://localhost:3000" : "https://www.mapme.run";

const defaultConfig = function () {
  return {
    startAddress: "",
    endAddress: "",
    map: null,
    mapDetails: null,
    directionsDisplay: null,
    route: {
      start: {},
      end: {},
      distance: 0,
      line: new google.maps.Polyline({
        path: [],
        strokeColor: '#FF0000',
        strokeWeight: 2
      })
    },
    athletes: [],
    infoWindow: new google.maps.InfoWindow({
      size: new google.maps.Size(150, 50)
    })
  };
}
let config = {};
const mapKey = "AIzaSyDpHo5sA8q1SbWWTr_vUplPH7cicNib_2g";

let googleMapsScriptIsInjected = false;

const injectGoogleMapsApiScript = (options = {}) => {
  if (googleMapsScriptIsInjected) {
    throw new Error('Google Maps Api is already loaded.');
  }

  const optionsQuery = Object.keys(options)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(options[k])}`)
    .join('&');

  const url = `https://maps.googleapis.com/maps/api/js?${optionsQuery}`;

  const script = document.createElement('script');

  script.setAttribute('src', url);
  script.setAttribute('async', '');
  script.setAttribute('defer', '');

  document.head.appendChild(script);

  googleMapsScriptIsInjected = true;
};

let googleMapsApiPromise = null;
let mapLoadedPromise = null;

const loadGoogleMapsApi = (apiKey, options = {}) => {
  if (!googleMapsApiPromise) {
    googleMapsApiPromise = new Promise((resolve, reject) => {
      try {
        window.onGoogleMapsApiLoaded = resolve;

        injectGoogleMapsApiScript({
          key: apiKey,
          callback: 'onGoogleMapsApiLoaded',
          ...options,
        });
      } catch (error) {
        reject(error);
      }
    }).then(() => createGoogleMapsExtensions()).then(() => window.google.maps);
  }

  return googleMapsApiPromise;
};

window.addEventListener("hashchange", tryLoadMap, false);

// Try and look up a map based on the map code
tryLoadMap();

// Attempt to get the logged in user
getLoggedInUser();

function tryLoadMap() {
  let mapCode = lookupMapCode();

  if (mapCode) {
    removeLeaderboard();
    addLoadingSpinner();

    loadMap(mapCode);
  } else {
    // Clear existing top bar and leaderboards
    clearMapPage();

    // Choose new map
    fetch(apiURL + '/get-maps', {credentials: 'include'}).then(res => res.json()).then(maps => {
      console.log("maps list", maps);
      maps.forEach((map, index) => {
        const link = document.createElement("a");
        link.href = "/#/" + map.code;

        const img = document.createElement("img");
        const mapStart = `${map.start_city}, ${map.start_country}`;
        const mapEnd = `${map.end_city}, ${map.end_country}`;
        const mapCentre = `${map.map_centre}`;
        const src = "https://maps.googleapis.com/maps/api/staticmap?key=" + mapKey + "&zoom=5&size=980x450&maptype=roadmap";
        const centre = "&center=" + mapCentre;
        const startMarker = "&markers=color:green%7Clabel:S%7C" + mapStart;
        const endMarker ="&markers=color:red%7Clabel:F%7C" + mapEnd;
        img.src = src + centre + startMarker + endMarker;
        img.setAttribute("alt", `A map from ${mapStart} to ${mapEnd}`);
        
        if (index === 0) {
          const ol = document.createElement("ol");
          ol.classList.add("maps-list-grid");
          document.querySelector("main").appendChild(ol);
        }

        const list = document.querySelector(".maps-list-grid");
        const li = document.createElement("li");

        link.innerHTML = `<span class="map-name">${map.name}</span>`;
        link.innerHTML += `<span class="map-year">${map.year}</span>`;
        link.innerHTML += `<span class="map-start">${map.start_city}</span>`;
        link.innerHTML += `<span class="map-end">${map.end_city}</span>`;
        // link.innerHTML += `<span class="checkpoint-count">0</span>`;
        // link.innerHTML += `<span class="athlete-count">0</span>`;
        link.appendChild(img);

        if (map.solo) {
          li.classList.add("solo-map");
        }

        li.appendChild(link);
        list.appendChild(li);
      });
    });
  }
}

function clearMapPage() {
  removeNode(".route-details");
  document.querySelector("main").innerHTML = "";
  removeLeaderboard();
  document.body.classList.remove("map-page");
}

function setupMapPage(map) {
  document.body.classList.add("map-page");
  addRouteDetails();
  updateRouteDetailsTitle(map.name);
  resetConfig();
  loadDefaultMap();
}

function loadDefaultMap() {
  document.querySelector("main").innerHTML = "";
  const canvas = document.createElement("div");
  canvas.setAttribute("id", "map-canvas");
  document.querySelector("main").appendChild(canvas);

  // Create a default basic map
  const myOptions = {
    zoom: 3,
    mapTypeId: google.maps.MapTypeId.ROADMAP,
    center: { lat: 0, lng: 0 }
  }
  config.map = new google.maps.Map(document.querySelector("#map-canvas"), myOptions);
}

function loadMap(mapCode) {
  mapLoadedPromise = fetch(apiURL + '/get-map/' + mapCode, {credentials: 'include'}).then(async res => {
    if (res.ok) {
      const map = await res.json();

      loadGoogleMapsApi(mapKey, {
        libraries: "geometry,places",
        v: "beta",
        map_ids: "5ba6774e3b35ec6b"
      }).then(() => {
        console.log(map);
        setupMapPage(map);
        getLoggedInUser();

        config.mapDetails = map;
        config.mapCode = mapCode;
        config.startAddress = `${map.start_city}, ${map.start_country}`;
        config.endAddress = `${map.end_city}, ${map.end_country}`;

        // Centre the map on the start location.
        // Use the geocoder to get the address details. We could hardcode in the lat/lng but this is useful for dynamic, user-defined, start locations.
        if (config.startAddress) {
          const geocoder = new google.maps.Geocoder();
          geocoder.geocode({'address': config.startAddress}, results => config.map.setCenter(results[0].geometry.location));
        }

        // Create a renderer for directions and bind it to the map.
        config.directionsDisplay = new google.maps.DirectionsRenderer({map: config.map});

        // Draw the lines and get the directions
        const getDirectionsPromise = getDirectionsForRoute();

        // Draw where the athletes are along the route based on their progress
        getDirectionsPromise.then(() => getAthletesDetails()).catch(e => console.log(e));
      });
    } else if (res.status === 404) {
      removeLoadingSpinner();
      console.log('Map not found');
    }
  });
}

function lookupMapCode() {
  let mapCode = null;
  if (location.hash.indexOf("#/") > -1) {
    mapCode = location.hash.substring(2);
  } else {
    mapCode = localStorage.getItem("mapCode");
  }
  return mapCode;
}

function resetConfig() {
  config = defaultConfig();
}

function getLoggedInUser() {
  fetch(apiURL + '/get-logged-in-user', {credentials: 'include'}).then(res => {
    res.json().then(user => {
      // Display add to map button
      if (mapLoadedPromise) {
        mapLoadedPromise.then(() => {
          const topBar = document.querySelector(".top-bar");

          // Show an 'Add myself to map' button if the top bar exists and the map isn't a "solo" one
          if (topBar && (config && config.mapDetails && !config.mapDetails.solo)) {
            const addRemoveButton = document.querySelector(".add-remove-to-map-button") || document.createElement("button");
            // And if the user isn't already added to the map, else show a leave map button
            addRemoveButton.classList.add("add-remove-to-map-button");
            if (user.maps.indexOf(config.mapCode) === -1) {
              addRemoveButton.innerText = "+ Add myself to map";
              addRemoveButton.addEventListener("click", addRemoveUserToMap.bind(this, "add"));
            } else {
              addRemoveButton.innerText = "Leave map";
              addRemoveButton.addEventListener("click", addRemoveUserToMap.bind(this, "remove"));
            }

            topBar.appendChild(addRemoveButton);
          } else {
            removeNode(".add-remove-to-map-button")
          }
        });
      }
    }).catch(() => {
      // Display login button
      const topBar = document.querySelector(".top-bar");
      if (topBar) {
        const loginButton = document.querySelector(".auth-button") || document.createElement("a");
        loginButton.classList.add("auth-button");
        loginButton.innerText = "Login using Strava";
        loginButton.setAttribute("href", apiURL + "/add-user");

        topBar.appendChild(loginButton);
      }
    });
  });
}

function addRemoveUserToMap(verb) {
  fetch(apiURL + '/get-map/' + config.mapCode + '/' + verb, {
    method: 'post',
    credentials: 'include'
  }).then(res => {
    if (res.ok) {
      tryLoadMap();
    }
  });
}

// Create the marker and attach a click handler
function createAthleteMarker(athlete) {
  return new Promise(resolve => {
    checkUrlExists(athlete.profile_picture).then(imageExists => {
      const icon = imageExists ? {url: athlete.profile_picture, size: new google.maps.Size(60, 60), scaledSize: new google.maps.Size(60, 60)} : undefined;

      const marker = new google.maps.Marker({
        position: config.route.start.latlng,
        map: config.map,
        title: athlete.username,
        zIndex: Math.round(config.route.start.latlng.lat() * -100000)<<5,
        icon
      });
      athlete.marker = marker;

      google.maps.event.addListener(marker, 'click', () => displayMarkerPopup(athlete));
      resolve(marker);
    });
  });
}

function displayMarkerPopup(athlete) {
  const athleteDistance = parseFloat((getAthleteDistanceForYear(athlete) / 1000).toFixed(2), 10);
  const routeDistance = parseFloat((config.route.distance / 1000).toFixed(2), 10);
  const distanceRemaining = routeDistance - athleteDistance;
  const percentageCompleted = getPercentageOfRouteCompleted(getAthleteDistanceForYear(athlete));

  let content = `<div class='marker-popup'>
                  <b>${athlete.username}</b><br>
                  ${athleteDistance.toLocaleString()} km<br>`;
  
  if (distanceRemaining > 0) {
    content += `${distanceRemaining.toLocaleString()} km remaining<br>`;
  }

  content += `<b class="progress">${percentageCompleted}%</b><br>
              <b class="nearest">${getAthleteLocalityInfo(athlete)}</b>
            </div>`;

  config.infoWindow.setContent(content);
  config.infoWindow.open(config.map, athlete.marker);
}

function checkUrlExists(url) {
  return new Promise(resolve => {
    const image = new Image();
    image.addEventListener('load', () => resolve(true));
    image.addEventListener('error', () => resolve(false));
    image.src = url;
  });
}

function getPercentageOfRouteCompleted(totalDistance) {
  return Math.min(parseFloat(((totalDistance / 1000) / (config.route.distance / 1000) * 100).toFixed(2), 10), 100);
}

// Route the directions and pass the response to a function to create markers
function getDirectionsForRoute() {
  return new Promise((resolve, reject) => {
    const request = {
      origin: config.startAddress,
      destination: config.endAddress,
      travelMode: google.maps.DirectionsTravelMode[config.mapDetails.travel_mode ? config.mapDetails.travel_mode : 'WALKING']
    };

    const directionsService = new google.maps.DirectionsService();
    directionsService.route(request, (response, status) => plotRouteOnMap(response, status, resolve, reject));
  });
}

function plotRouteOnMap(response, status, resolve, reject) {
  if (status == google.maps.DirectionsStatus.OK) {
    removeLoadingSpinner();

    config.directionsDisplay.setDirections(response);
    const bounds = new google.maps.LatLngBounds();
    const legs = response.routes[0].legs;

    for (let i = 0; i < legs.length; i++) {
      // On the first leg (there might only be one) set the start locations
      if (i == 0) {
        config.route.start.latlng = legs[i].start_location;
        config.route.start.address = legs[i].start_address;
      }

      // Store the end location
      config.route.end.latlng = legs[i].end_location;
      config.route.end.address = legs[i].end_address;
      const steps = legs[i].steps;

      // Iterate over each step on this leg and update the route's polyline
      for (let j = 0; j < steps.length; j++) {
        const nextSegment = steps[j].path;

        for (let k = 0; k < nextSegment.length; k++) {
          config.route.line.getPath().push(nextSegment[k]);
          bounds.extend(nextSegment[k]);
        }
      }
    }

    // Add the route line to the map
    config.route.line.setMap(config.map);
    config.map.setCenter(config.route.line.getPath().getAt(0));
    config.map.fitBounds(bounds);

    // Calculate the length of the route
    config.route.distance = google.maps.geometry.spherical.computeLength(config.route.line.getPath());
    updateRouteDetailsDistance(config.route.distance);
    resolve();
  } else {
    reject();
  }
}

// Get athletes details from the server
function getAthletesDetails() {
  fetch(apiURL + '/get-map/' + config.mapCode + "/users", {credentials: 'include'}).then(res => res.json()).then(res => {
    if (!res.error) {
      config.athletes = res;

      updateAthleteLocations();
    }
  });
}

function updateAthleteLocations() {
  if (config.athletes && config.athletes.length) {
    config.athletes.forEach((athlete, index) => {
      if (!athlete.error) {
        athlete.totalDistance = getAthleteDistanceForYear(athlete);

        // Create a marker for this athlete
        const createMarker = createAthleteMarker(athlete);

        // Get the distance on the route line. Use the route end if completed or exceeded
        const positionOnRoute = athlete.totalDistance >= config.route.distance ? config.route.end.latlng : config.route.line.GetPointAtDistance(athlete.totalDistance);

        createMarker.then(marker => marker.setPosition(positionOnRoute));

        // Update the map and marker for the leader
        if (index === 0) {
          config.map.panTo(positionOnRoute);
          config.map.setZoom(10);

          if (!config.mapDetails.solo) {
            addLeaderboard();
          }
        }

        if (config.mapDetails.solo) {
          addSoloProgress(athlete);
        } else {
          addToLeaderboard(athlete);
        }

        // Reverse geocode to try and get a place name
        // Update leaderboard with nearest locations
        if (config.mapDetails.geocode_lookup) {
          getNearestLocality(athlete, positionOnRoute).then(() => {
            if (!config.mapDetails.solo) {
              displayNearestLocalityInLeaderboard(athlete);
            } else {
              displayNearestLocalityInSoloProgress(athlete);
            }
          });
        }

        updateAthleteDistanceLine(athlete);
      }
    });
  }
}

function getAthleteDistanceForYear(athlete) {
  const year = config.mapDetails.year;
  const distance = 0;
  if (athlete.stats[year] && athlete.stats[year].full.type === "run") {
    return athlete.stats[year].full.total;
  }
  return distance;
}

// Update the athlete's line on the map.
// Get the index on the route's line for their distance and use this to create a second line.
function updateAthleteDistanceLine(athlete) {
  const pathIndexAtDistance = config.route.line.GetIndexAtDistance(getAthleteDistanceForYear(athlete));
  athlete.line = new google.maps.Polyline({path: config.route.line.getPath().getArray().slice(0, pathIndexAtDistance), strokeColor: "#0000FF", strokeWeight: 6});
  athlete.line.setMap(config.map);
}

// Reverse geocode to try and get a place name from the location
async function getNearestLocality(athlete, location) {
  const geocoder = new google.maps.Geocoder();
  return geocoder.geocode({location}, results => reverseGeoCodeLookups(athlete, results));
}

// Try and get the nearest locality that matches the athlete's current location
function reverseGeoCodeLookups(athlete, geocodeResults) {
  let nearestLocality = "";
  let nearestCountry = "";

  if (geocodeResults && config.mapDetails.geocode_lookup) {
    // Try and get the locality information
    let localityMatches = getReverseGeocodeResultForType(geocodeResults, 'locality');
    if (!localityMatches.length) {
      localityMatches = getReverseGeocodeResultForType(geocodeResults, 'postal_town');
    }

    if (config.mapDetails.geocode_lookup.indexOf("locality") > -1 && localityMatches.length) {
      nearestLocality = localityMatches[0].short_name;
    }

    // Also try and get the country name
    const countryMatches = getReverseGeocodeResultForType(geocodeResults, 'country');

    if (config.mapDetails.geocode_lookup.indexOf("country") > -1 && countryMatches.length) {
      nearestCountry = countryMatches[0].long_name;
    }
  }
  athlete.nearestLocalityInfo = {nearestLocality, nearestCountry};
}

function getReverseGeocodeResultForType(geocodeResults, type) {
  return geocodeResults[0].address_components.filter(ac => ac.types.indexOf(type) > -1)
}

function getAthleteLocalityInfo(athlete, divider = "<br>") {
  let localityInfo = "";
  if (athlete.nearestLocalityInfo) {
    localityInfo = athlete.nearestLocalityInfo.nearestLocality;

    if (athlete.nearestLocalityInfo.nearestLocality && athlete.nearestLocalityInfo.nearestCountry) {
      localityInfo += divider;
    }
    localityInfo += athlete.nearestLocalityInfo.nearestCountry;
  }
  return localityInfo;
}

// DOM functions
function addLoadingSpinner() {
  document.querySelector(".loading-spinner").classList.remove("hidden");
}

function removeLoadingSpinner() {
  document.querySelector(".loading-spinner").classList.add("hidden");
}

function updateRouteDetailsTitle(title) {
  let titleEl = document.querySelector(".route-details .route-title");
  if (!titleEl) {
    titleEl = document.createElement("span");
    titleEl.classList.add("route-title");
    document.querySelector(".route-details").appendChild(titleEl);
  }
  titleEl.innerText = title;
}

function updateRouteDetailsDistance(distance) {
  const distanceEl = document.querySelector(".route-details .route-distance") || document.createElement("span");
  distanceEl.classList.add("route-distance");
  document.querySelector(".route-details").appendChild(distanceEl);

  distanceEl.innerHTML = ` &#8226; ${parseFloat((distance / 1000).toFixed(2), 10).toLocaleString()} km &#8226; `;
}

function addRouteDetails() {
  const div = document.querySelector(".route-details") || document.createElement("div");
  div.classList.add("route-details");
  document.querySelector("header").appendChild(div);
}

function addLeaderboard() {
  const ol = document.createElement("ol");
  ol.classList.add("athlete-leaderboard");
  document.querySelector("header").appendChild(ol);

  addLeaderboardTitle();
}

function removeLeaderboard() {
  removeNode(".athlete-leaderboard");
  removeNode(".route-leaderboard-toggle");
}

function removeNode(selector) {
  const node = document.querySelector(selector);
  if (node) {
    node.remove();
  }
}

function addLeaderboardTitle() {
  const viewLeaderboardLink = document.querySelector("route-leaderboard-toggle") || document.createElement("a");
  viewLeaderboardLink.innerText = "Show leaderboard";
  viewLeaderboardLink.classList.add("route-leaderboard-toggle");
  viewLeaderboardLink.addEventListener("click", toggleLeaderboard);
  document.querySelector(".route-details").appendChild(viewLeaderboardLink);
}

function addToLeaderboard(athlete) {
  const li = document.createElement("li");
  li.classList.add("athlete-score");
  li.setAttribute("athlete-id", athlete.id);
  document.querySelector(".athlete-leaderboard").appendChild(li);

  // Create an element for the athlete's name
  const nameBadge = document.createElement("span");
  nameBadge.classList.add("athlete-name");
  nameBadge.innerText = athlete.username;
  li.appendChild(nameBadge);
}

function addSoloProgress(athlete) {
  const soloProgressEl = document.querySelector(".route-details .solo-progress") || document.createElement("span");
  soloProgressEl.classList.add("solo-progress");
  document.querySelector(".route-details").appendChild(soloProgressEl);

  const distance = parseFloat((getAthleteDistanceForYear(athlete) / 1000).toFixed(2), 10).toLocaleString();
  const percentageComplete = getPercentageOfRouteCompleted(getAthleteDistanceForYear(athlete));

  soloProgressEl.innerHTML = ` ${athlete.username} &#8226; <span class="progress">${distance} km (${percentageComplete}%)</span>`;
}

function displayNearestLocalityInSoloProgress(athlete) {
  const soloProgressEl = document.querySelector(".route-details .solo-progress");
  const localityInfo = getAthleteLocalityInfo(athlete, ", ");
  soloProgressEl.innerHTML += ` &#8226; ${localityInfo}`;
}

function toggleLeaderboard() {
  const shown = document.querySelector(".athlete-leaderboard").classList.toggle("show");
  const viewLeaderboardLink = document.querySelector(".route-leaderboard-toggle");
  const verb = shown ? "Hide" : "Show";
  viewLeaderboardLink.innerText = `${verb} leaderboard`;
}

// Update the leaderboard with the locality info and the progress completed percentage
function displayNearestLocalityInLeaderboard(athlete) {
  const li = document.querySelector(`[athlete-id="${athlete.id}"]`);

  // Create an element for their progress
  const progress = document.createElement("span");
  progress.classList.add("progress");
  progress.innerText = `${getPercentageOfRouteCompleted(getAthleteDistanceForYear(athlete))}%`;
  li.appendChild(progress);

  // Create an element for their locality and distance info
  const locality = document.createElement("span");
  locality.classList.add("locality");
  const distance = parseFloat((getAthleteDistanceForYear(athlete) / 1000).toFixed(2), 10);
  locality.innerHTML = `${distance.toLocaleString()} km &#8226; ${getAthleteLocalityInfo(athlete, ", ")}`;
  li.appendChild(locality);
}

// Extend the Google Maps API with some custom methods. Credit: http://jsfiddle.net/geocodezip/kzcm02d6/136/
function createGoogleMapsExtensions() {
  // === A method which returns a GLatLng of a point a given distance along the path ===
  // === Returns null if the path is shorter than the specified distance ===
  google.maps.Polyline.prototype.GetPointAtDistance = function(metres) {
    // some awkward special cases
    if (metres === 0) {
      return this.getPath().getAt(0);
    }

    if (metres < 0 || this.getPath().getLength() < 2) {
      return null;
    }

    let currentDistance = 0;
    let oldDistance = 0;
    let i = 1;
    for (i = 1; (i < this.getPath().getLength() && currentDistance < metres); i++) {
      oldDistance = currentDistance;
      currentDistance += google.maps.geometry.spherical.computeDistanceBetween(this.getPath().getAt(i), this.getPath().getAt(i - 1));
    }

    if (currentDistance < metres) {
      return null;
    }

    const p1 = this.getPath().getAt(i - 2);
    const p2 = this.getPath().getAt(i - 1);
    const m = (metres - oldDistance) / (currentDistance - oldDistance);
    return new google.maps.LatLng(p1.lat() + (p2.lat() - p1.lat()) * m, p1.lng() + (p2.lng() - p1.lng()) * m);
  }

  // === A method which returns the Vertex number at a given distance along the path ===
  // === Returns null if the path is shorter than the specified distance ===
  google.maps.Polyline.prototype.GetIndexAtDistance = function(metres) {
    // some awkward special cases
    if (metres == 0) {
      return this.getPath().getAt(0);
    }

    if (metres < 0) {
      return null;
    }

    let currentDistance = 0;
    let i = 1;
    for (i = 1; (i < this.getPath().getLength() && currentDistance < metres); i++) {
      currentDistance += google.maps.geometry.spherical.computeDistanceBetween(this.getPath().getAt(i), this.getPath().getAt(i - 1));
    }

    if (currentDistance < metres) {
      return null;
    }

    return i;
  }
}