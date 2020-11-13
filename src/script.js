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
  athlete: {
    name: "",
    icon: "",
    marker: null,
    totalDistance: 0,
    line: null
  },
  infoWindow: new google.maps.InfoWindow({
    size: new google.maps.Size(150, 50)
  })
};

google.maps.event.addDomListener(window, "load", initialize);

const getDestinations = fetch('/get-destinations').then(res => res.json()).then(res => {
  config.startAddress = res.startAddress;
  config.endAddress = res.endAddress;
});

const getMapsId = fetch('/get-maps-id');

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

    // Draw where the athlete is along the route based on their progress
    getAthleteDetails();
  });
}

// Create the marker and attach a click handler
function createAthleteMarker(latlng, label, icon) {
  const marker = new google.maps.Marker({
    position: latlng,
    map: config.map,
    title: label,
    icon,
    zIndex: Math.round(latlng.lat() * -100000)<<5
  });

  google.maps.event.addListener(marker, 'click', function() {
    const athleteDistance = parseFloat((config.athlete.totalDistance / 1000).toFixed(2), 10).toLocaleString();
    const routeDistance = parseFloat((config.route.distance / 1000).toFixed(2), 10).toLocaleString();
    config.infoWindow.setContent(`<b>${label}</b><br>My distance run: ${athleteDistance} km<br>Total route distance: ${routeDistance} km`);
    config.infoWindow.open(config.map, marker);
  });

  return marker;
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
      // On the first leg (there might only be one) create the athlete marker
      if (i == 0) {
        config.route.start.latlng = legs[i].start_location;
        config.route.start.address = legs[i].start_address;
        config.athlete.marker = createAthleteMarker(config.route.start.latlng, config.athlete.name, config.athlete.icon);
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

// Get athlete details from the server
function getAthleteDetails() {
  fetch('/user').then(res => res.json()).then(res => {
    config.athlete.name = res.user.displayName;
    config.athlete.icon = res.user._json.profile_medium;
    config.athlete.totalDistance = res.user.ytd_run_totals.distance;

    setTimeout(() => updateAthleteLocation(), 2000);
  });
}

function updateAthleteLocation() {
  const distance = config.athlete.totalDistance;

  // If the total distance has exceeded the route, set the map to the end location
  config.route.distance = google.maps.geometry.spherical.computeLength(config.route.line.getPath());
  if (distance > config.route.distance) {
    config.map.panTo(config.route.end.latlng);
    config.athlete.marker.setPosition(config.route.end.latlng);
    return;
  }

  // Get the distance on the route line
  const positionOnRoute = config.route.line.GetPointAtDistance(distance);

  // Update the map and marker
  config.map.panTo(positionOnRoute);
  config.athlete.marker.setPosition(positionOnRoute);

  updateAthleteDistanceLine();
}

// Update the athlete's line on the map.
// Get the index on the route's line for their distance and use this to create a second line.
function updateAthleteDistanceLine() {
  const pathIndexAtDistance = config.route.line.GetIndexAtDistance(config.athlete.totalDistance);
  config.athlete.line = new google.maps.Polyline({path: config.route.line.getPath().getArray().slice(0, pathIndexAtDistance), strokeColor: "#0000FF", strokeWeight: 6});
  config.athlete.line.setMap(config.map);
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