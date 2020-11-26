const apiURL = location.hostname === "localhost" ? "http://localhost:3000" : "https://mapme-run.herokuapp.com";
document.querySelector('.auth-button').setAttribute("href", apiURL + "/add-user");

const config = {
  startAddress: "",
  endAddress: "",
  map: null,
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

google.maps.event.addDomListener(window, "load", initialize);

const getDestinations = fetch(apiURL + '/get-destinations').then(res => res.json()).then(res => {
  config.startAddress = res.startAddress;
  config.endAddress = res.endAddress;
});

const getMapsId = fetch(apiURL + '/get-maps-id');

function initialize() {
  getMapsId.then(res => res.json()).then(mapResponse => {
    // Create a map
    const myOptions = {
      zoom: 15,
      mapTypeId: google.maps.MapTypeId.ROADMAP,
      mapId: mapResponse.id
    }
    config.map = new google.maps.Map(document.getElementById("map-canvas"), myOptions);

    // Centre the map on the start location.
    // Use the geocoder to get the address details. We could hardcode in the lat/lng but this is useful for dynamic, user-defined, start locations.
    if (config.startAddress) {
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({'address': config.startAddress}, results => config.map.setCenter(results[0].geometry.location));
    }

    // Create a renderer for directions and bind it to the map.
    config.directionsDisplay = new google.maps.DirectionsRenderer({map: config.map});

    // Draw the lines and get the directions
    getDirectionsForRoute();

    // Draw where the athletes are along the route based on their progress
    getAthletesDetails();
  });
}

// Create the marker and attach a click handler
function createAthleteMarker(athlete) {
  return new Promise(resolve => {
    checkUrlExists(athlete.profile_picture).then(imageExists => {
      const icon = imageExists ? {url: athlete.profile_picture, scaledSize: new google.maps.Size(60, 60)} : undefined;

      const marker = new google.maps.Marker({
        position: config.route.start.latlng,
        map: config.map,
        title: athlete.username,
        zIndex: Math.round(config.route.start.latlng.lat() * -100000)<<5,
        icon
      });
      athlete.marker = marker;

      google.maps.event.addListener(marker, 'click', function() {
        const athleteDistance = parseFloat((athlete.ytd_run_totals / 1000).toFixed(2), 10).toLocaleString();
        const routeDistance = parseFloat((config.route.distance / 1000).toFixed(2), 10).toLocaleString();
        config.infoWindow.setContent(`
          <div class='marker-popup'>
            <b>${athlete.username}</b><br>
            Distance run: ${athleteDistance} km<br>
            Total route distance: ${routeDistance} km<br>
            <b class="progress">${getPercentageOfRouteCompleted(athlete.ytd_run_totals) + "%</b> " + (athlete.nearestLocalityInfo ? athlete.nearestLocalityInfo.nearestLocality + (athlete.nearestLocalityInfo.nearestCountry ? ", " + athlete.nearestLocalityInfo.nearestCountry : "") : "")}
          </div>`);
        config.infoWindow.open(config.map, marker);
      });
      resolve(marker);
    });
  });
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
  getDestinations.then(() => {
    const request = {
      origin: config.startAddress,
      destination: config.endAddress,
      travelMode: google.maps.DirectionsTravelMode.DRIVING
    };

    const directionsService = new google.maps.DirectionsService();
    directionsService.route(request, plotRouteOnMap);
  });
}

function plotRouteOnMap(response, status) {
  if (status == google.maps.DirectionsStatus.OK) {
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
  }
}

// Get athletes details from the server
function getAthletesDetails() {
  fetch(apiURL + '/get-user-totals').then(res => res.json()).then(res => {
    if (!res.error) {
      config.athletes = res;

      setTimeout(() => updateAthleteLocations(), 2000);
    }
  });
}

function updateAthleteLocations() {
  if (config.athletes && config.athletes.length) {
    config.athletes.forEach((athlete, index) => {
      if (!athlete.error) {
        const distance = athlete.ytd_run_totals;

        // Create a marker for this athlete
        const createMarker = createAthleteMarker(athlete);

        // If the total distance has exceeded the route, set the map to the end location
        config.route.distance = google.maps.geometry.spherical.computeLength(config.route.line.getPath());
        if (distance > config.route.distance) {
          config.map.panTo(config.route.end.latlng);
          config.map.setZoom(15);
          createMarker.then(marker => marker.setPosition(config.route.end.latlng));

          // Reverse geocode to try and get a place name
          // Update header with nearest locations
          getNearestLocality(config.route.end.latlng).then(() => displayAthleteHeaderTimer(athlete, index));
          return;
        }

        // Get the distance on the route line
        const positionOnRoute = config.route.line.GetPointAtDistance(distance);

        // Update the map and marker
        config.map.panTo(positionOnRoute);
        config.map.setZoom(8);
        createMarker.then(marker => marker.setPosition(positionOnRoute));

        // Reverse geocode to try and get a place name
        // Update header with nearest locations
        getNearestLocality(athlete, positionOnRoute).then(() => displayAthleteHeaderTimer(athlete, index));

        updateAthleteDistanceLine(athlete);
      }
    });
  }
}

// Update the athlete's line on the map.
// Get the index on the route's line for their distance and use this to create a second line.
function updateAthleteDistanceLine(athlete) {
  const pathIndexAtDistance = config.route.line.GetIndexAtDistance(athlete.ytd_run_totals);
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

  if (geocodeResults) {
    // Try and get the locality information
    let localityMatches = getReverseGeocodeResultForType(geocodeResults, 'locality');
    if (!localityMatches.length) {
      localityMatches = getReverseGeocodeResultForType(geocodeResults, 'postal_town');
    }

    if (localityMatches.length) {
      nearestLocality = localityMatches[0].short_name;

      // Also try and get the country name
      const countryMatches = getReverseGeocodeResultForType(geocodeResults, 'country');

      if (countryMatches.length) {
        nearestCountry = countryMatches[0].short_name;
      }
    }
  }
  athlete.nearestLocalityInfo = {nearestLocality, nearestCountry};
}

function getReverseGeocodeResultForType(geocodeResults, type) {
  return geocodeResults[0].address_components.filter(ac => ac.types.indexOf(type) > -1)
}

function displayAthleteHeaderTimer(athlete, athleteCount) {
  // If there are multiple athletes create a timer to rotate through them
  if (athleteCount > 1) {
    athlete.displayInterval = setInterval(function() {
      displayNearestLocalityInHeader(athlete);
    }, (athleteCount + 1) * 5000);
  } else {
    displayNearestLocalityInHeader(athlete);
  }
}

// Update the header with the locality info and the progress completed percentage
function displayNearestLocalityInHeader(athlete) {
  if (athlete.nearestLocalityInfo) {
    const nearest = document.querySelector("header .nearest");
    nearest.innerText = athlete.nearestLocalityInfo.nearestLocality;

    if (athlete.nearestLocalityInfo.nearestCountry) {
      nearest.innerText += ", " + athlete.nearestLocalityInfo.nearestCountry;
    }
  }

  const nameBadge = document.querySelector("header .athlete-name");
  nameBadge.innerText = athlete.username + " ";

  const progress = document.querySelector("header .progress");
  progress.innerText = getPercentageOfRouteCompleted(athlete.ytd_run_totals) + "%" + (athlete.nearestLocalityInfo && athlete.nearestLocalityInfo.nearestLocality ? ": " : "");
}

// Extend the Google Maps API with some custom methods. Credit: http://jsfiddle.net/geocodezip/kzcm02d6/136/

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