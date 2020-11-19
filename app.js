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
const session = require('express-session');
const app = express();

app.use(allowCrossDomain);
app.use(passport.initialize());
app.use(passport.session());

app.use(session({
  genid: (req) => {
    return '_' + Math.random().toString(36).substr(2, 9)
  },
  cookie: {
    maxAge: 24 * 60 * 60 * 365 * 1000
  },
  name: '_MapMe',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}));

const strava = require('strava-v3');

const stravaConfig = {
  clientID: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  callbackURL: process.env.STRAVA_CLIENT_CALLBACK_ENDPOINT
}

const strategy = new StravaStrategy(stravaConfig, (accessToken, refreshToken, profile, done) => {
  const user = {...profile, accessToken, refreshToken};
  done(false, user);
});

passport.use(strategy);
app.get('/auth', passport.authenticate('strava', {scope:['read']}));
app.get('/callback', passport.authenticate('strava', {
    successRedirect: '/',
    failureRedirect: '/error'
  })
);

app.get('/', (req, res) => {

  if (!req.session || !req.session.passport || !req.session.passport.user) {
    return res.redirect('/auth');
  }
  res.sendFile(path.join(__dirname + '/index.html'));
});

app.get('/user', async(req, res) => {
  if (!req.session || !req.session.passport || !req.session.passport.user) {
    return res.redirect('/auth');
  }

  strava.config({
    access_token: req.session.passport.user.accessToken,
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    redirect_uri: process.env.STRAVA_CLIENT_CALLBACK,
  });

  const result = await strava.athletes.stats({id: req.session.passport.user.id, access_token: req.session.passport.user.accessToken}).catch(errors.StatusCodeError, (e) => {
    if (e === 401) {
      return res.redirect('/auth');
    }
  });

  if (result) {
    const response = {...req.session.passport.user, ...result};
    res.json({user: response});
  } else {
    res.json({error: "Could not retrieve user"});
  }
});

app.get('/get-destinations', (req, res) => res.json({startAddress: process.env.START, endAddress: process.env.END}));

app.get('/get-maps-id', (req, res) => res.json({id: process.env.GOOGLE_MAPS_ID}));

app.get('/error', (req, res) => res.send('LOGIN'));

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