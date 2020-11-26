require('dotenv').config();
const path = require('path');
const https = require('https');
https.globalAgent.options.rejectUnauthorized = false

const allowCrossDomain = function(req, res, next) {
  res.header('Access-Control-Allow-Origin', process.env.ACCESS_CONTROL_ALLOW_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');

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
const dbConn = MongoClient.connect(process.env.DATABASE_URL)
const dbName = "MapMeDatabase";

app.use(allowCrossDomain);
app.use(passport.initialize());
app.use(passport.session());

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
    date_created: Date.now(),
    ytd_run_totals: 0
  };

  const dbUser = await findUser(user.id);

  // If user isn't in the database already, add the new user to the database and generate some stats
  if (!dbUser) {
    addUser(user).then(() => getStatsFromStrava(user)).then(() => done(false, user)).catch(console.dir);
  } else {
    done(false, user);
  }
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
        ytd_run_totals: distance,
        last_updated: Date.now()
      }
    };
    dbConn.then(client => client.db(dbName).collection("users").updateOne(filter, update));
  } catch (err) {
    console.log("Update user error", err.stack);
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

async function findUsers() {
  try {
    return await dbConn.then(async client => {
      const userTable = client.db(dbName).collection("users");
      
      // Find all users, sort by ytd_run_totals asc
      return await userTable.find({}).sort({ytd_run_totals: 1});
    });

  } catch (err) {
    console.log("Find users error", err.stack);
    return null;
  }
}

passport.use(strategy);
app.get('/add-user', passport.authenticate('strava', {scope:['read']}));
app.get('/callback', passport.authenticate('strava', {
    successRedirect: '/',
    failureRedirect: '/error'
  })
);

app.get('/', (req, res) => res.redirect(process.env.AUTH_SUCCESS_REDIRECT));

app.get('/get-user-totals', async(req, res) => {
  const users = await findUsers();
  let response = [];

  if (users) {
    users.toArray().then(usersArray => {
      usersArray.forEach(u => {
        refreshAthleteStats(u).then(result => {
          if (result) {
            response.push(result);
          }

          // Use promise and resolve when finished instead of this...
          if (response.length === usersArray.length) {
            res.json(response);
          }
        });
      });
    });
  } else {
    res.json(response);
  }
});

async function refreshAthleteStats(user) {
  // If the record in the database is potentially stale (over 60 seconds old)
  if (!user.last_updated || user.last_updated < Date.now() - 60000) {
    getStatsFromStrava(user);
  }

  return user;
}

async function getStatsFromStrava(user) {
  // Query the Strava API for a fresh record
  strava.config({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    redirect_uri: process.env.STRAVA_CLIENT_CALLBACK,
  });
  const newTokenDetails = await strava.oauth.refreshToken(user.refresh_token);
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

app.get('/get-destinations', (req, res) => res.json({startAddress: process.env.START, endAddress: process.env.END}));

app.get('/get-maps-id', (req, res) => res.json({id: process.env.GOOGLE_MAPS_ID}));

app.get('/error', (req, res) => res.send('LOGIN ERROR'));

passport.serializeUser((user, done) => done(null, user))
passport.deserializeUser((id, done) => done(null, id));

app.use('/src', express.static(path.join(__dirname, 'src')))

app.use(express.json()); // to parse application/json

let port = process.env.PORT;
if (!port) {
  port = 3000;
}
app.listen(port, function() {
    console.log(`Listening on port ${port}`);
});
