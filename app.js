require('dotenv').config();
const path = require('path');
const https = require('https');
https.globalAgent.options.rejectUnauthorized = false

const allowCrossDomain = function(req, res, next) {
  res.header('Access-Control-Allow-Origin', process.env.ACCESS_CONTROL_ALLOW_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', true);

  // intercept OPTIONS method
  if ('OPTIONS' == req.method) {
    res.send(200);
  }
  else {
    next();
  }
};

const errors = require('request-promise/errors');

const passport = require('passport')
const StravaStrategy = require('passport-strava-oauth2').Strategy

const express = require("express");
const app = express();

const {MongoClient} = require("mongodb");
const mongoose = require('mongoose');
const {Schema} = mongoose;

const userSchema = new Schema({
  id: String,
  username: String,
  family_name: String,
  given_name: String,
  profile_picture: String,
  refresh_token: String,
  date_created: {type: Date, default: Date.now},
  last_updated: {type: Date},
  roles: [String],
  maps: [String],
  stats: Schema.Types.Mixed
});

const User = mongoose.model('User', userSchema);

const mapSchema = new Schema({
  code: String,
  private: Boolean,
  locked: Boolean,
  name: String,
  solo: Boolean,
  active: Boolean,
  year: Number,
  start_city: String,
  start_country: String,
  end_city: String,
  end_country: String,
  map_centre: String,
  created_date: {type: Date, default: Date.now},
  created_by: String,
  waypoints: Schema.Types.Mixed,
  passcode: String
});

const Map = mongoose.model('Map', mapSchema);

const dbConn = MongoClient.connect(process.env.DATABASE_URL);
const dbName = "MapMeDatabase";

mongoose.connect(process.env.DATABASE_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false,
  useCreateIndex: true
});

const session = require('express-session');
const MongoStore = require('connect-mongo')(session);

app.use(session({
  store: new MongoStore({mongooseConnection: mongoose.connection, ttl: 365 * 24 * 60 * 60}),
  resave: false,
  saveUninitialized: false,
  secret: process.env.SESSION_SECRET,
  cookie: {
    httpOnly: false,
    secure: true
  }
}));

app.use(allowCrossDomain);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
  const dbUser = await findUser(id);
  done(null, dbUser);
});

const strava = require('strava-v3');

const stravaConfig = {
  clientID: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  callbackURL: process.env.STRAVA_CLIENT_CALLBACK_ENDPOINT
}

const strategy = new StravaStrategy(stravaConfig, async (accessToken, refreshToken, profile, done) => {
  const user = {
    id: profile.id,
    username: profile.displayName,
    family_name: profile.name.familyName,
    given_name: profile.name.givenName,
    profile_picture: profile._json.profile_medium,
    refresh_token: refreshToken,
    roles: ["User"],
    date_created: Date.now()
  };

  const dbUser = await findUser(user.id);

  // If user isn't in the database already, add the new user to the database and generate some stats
  if (!dbUser) {
    addUser(user).then(() => getStatsFromStrava(user)).then(() => done(false, user)).catch(console.dir);
  } else {
    done(false, user);
  }
});

passport.use(strategy);
app.get('/add-user', passport.authenticate('strava', {scope:['read']}));
app.get('/callback', passport.authenticate('strava', {
    successRedirect: '/',
    failureRedirect: '/error'
  })
);

app.get('/', (req, res) => res.redirect(process.env.AUTH_SUCCESS_REDIRECT));

app.get('/get-map/:mapCode', async(req, res) => {
  const map = await findMap(req.params.mapCode);
  if (map) {
    res.json(map);
  } else {
    res.sendStatus(404);
  }
});

app.post('/get-map/:mapCode/add', async(req, res) => {
  let success = false;
  console.log('req.isAuthenticated()', req.isAuthenticated());
  if (req.isAuthenticated() && req.session.passport.user) {
    success = await addUserToMap(req.session.passport.user, req.params.mapCode);
  }

  if (success) {
    res.sendStatus(200);
  } else {
    res.sendStatus(401);
  }
});

app.get('/get-map/:mapCode/users', async(req, res) => {
  const mapCode = req.params.mapCode;
  const map = await findMap(mapCode);
  let users = [];
  // If the map is a solo one then try and add the currently logged in user
  if (map && map.solo) {
    if (req.session && req.session.passport && req.session.passport.user) {
      const user = await findUser(req.session.passport.user)
      if (user) {
        users.push(user);
      }
    }
  } else {
    // Else return all users assigned to that map
    users = await findUsersByMapCode(mapCode);
  }

  let response = [];
  if (users) {
    users.forEach(u => {
      // If the record in the database is potentially stale (over 60 seconds old)
      if (!u.last_updated || u.last_updated < Date.now() - 60000) {
        getStatsFromStrava(u);
      }

      response.push(u);
    });
    res.json(response);
  } else {
    res.json(response);
  }
});

app.get('/get-maps', async(req, res) => {
  const maps = await findMaps();
  let response = [];
  if (maps) {
    maps.forEach(map => {
      response.push(map);
    });
    res.json(response);
  } else {
    res.json(response);
  }
});

app.get('/get-logged-in-user', async(req, res) => {
  if (req.session && req.session.passport && req.session.passport.user) {
    return res.json(await findUser(req.session.passport.user));
  }
  return res.sendStatus(401);
});

async function getStatsFromStrava(user) {
  // Query the Strava API for a fresh record
  strava.config({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    redirect_uri: process.env.STRAVA_CLIENT_CALLBACK,
  });
  const newTokenDetails = await strava.oauth.refreshToken(user.refresh_token).catch(error => console.log("Error refreshing Strava access token", error));

  const result = await strava.athletes.stats({id: user.id, access_token: newTokenDetails.access_token}).catch(errors.StatusCodeError, (e) => {
    if (e === 401) {
      // TODO handle error
      console.log('Strava error getting stats for', user);
    }
  });

  if (result) {
    // Update the database with this latest result
    updateUserTotal(user.id, result.ytd_run_totals.distance);
    return {...user, ...result, ytd_run_totals: result.ytd_run_totals.distance};
  } else {
    console.log('Error could not retrieve user', user);
    return null;
  }
}

app.get('/error', (req, res) => res.send('LOGIN ERROR'));

app.use('/src', express.static(path.join(__dirname, 'src')))

app.use(express.json()); // to parse application/json

let port = process.env.PORT;
if (!port) {
  port = 3000;
}
app.listen(port, function() {
    console.log(`Listening on port ${port}`);
});

// Database operations
async function addUser(user) {
  try {
    console.log('Adding user to db', user);
    return await dbConn.then(client => client.db(dbName).collection("users").insertOne(user));
  } catch (err) {
    console.log("Add user error", err.stack);
  }
}

async function updateUserTotal(userId, distance) {
  try {
    const filter = {id: userId};
    const update = {
      $set: {
        last_updated: Date.now()
      }
    };

    const stats = {
      "type": "run",
      "total": distance
    };

    // Update the user stats for the current year and month
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    update.$set[`stats.${year}.full`] = stats;
    update.$set[`stats.${year}.${month}`] = stats;

    dbConn.then(client => client.db(dbName).collection("users").updateOne(filter, update));
  } catch (err) {
    console.log("Update user error", err.stack);
  }
}

async function addUserToMap(userId, mapCode) {
  try {
    const filter = {id: userId};
    const update = {
      $addToSet: {maps: mapCode}
    };

    return dbConn.then(client => client.db(dbName).collection("users").updateOne(filter, update));
  } catch (err) {
    console.log("Add user to map error", err.stack);
  }
}

async function findUser(userId) {
  try {
    return await dbConn.then(async client => {
      return await client.db(dbName).collection("users").findOne({
        id: userId
      });
    });

  } catch (err) {
    console.log("Find user error", err.stack);
  }
}

async function findUsersByMapCode(mapCode) {
  try {
    // Find all users, sort by ytd_run_totals asc
    const year = new Date().getFullYear();
    return await User.find({maps: mapCode}, 'id username family_name given_name date_created last_updated profile_picture stats maps refresh_token')
    .sort({[`stats.${year}.full.total`]: -1}).exec();

  } catch (err) {
    console.log("Find users by map error", err.stack);
    return null;
  }
}

async function findMap(mapCode) {
  try {
    return await Map.findOne({code: mapCode}, 'name year solo start_city start_country end_city end_country waypoints').exec();

  } catch (err) {
    console.log("Find map error", err.stack);
  }
}

async function findMaps() {
  try {
      // Find all active (public) maps
      return await Map.find({private: false, active: true}, 'code name year locked solo start_city start_country end_city end_country map_centre waypoints').exec();
  } catch (err) {
    console.log("Find maps error", err.stack);
    return null;
  }
}