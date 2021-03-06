require('dotenv').config();

const express = require('express');
const bodyParser= require('body-parser');
const app = express();
const MongoClient = require('mongodb').MongoClient;
const ObjectId = require('mongodb').ObjectId;
const cors = require('cors');
const SyscoinClient = require('syscoin-core');
const syscoinAuth = require('syscoin-auth');
const fs = require('fs');

const config = require('./config');
let db, syscoinClient, rpcuser = "u", rpcpass = "p", rpcport = 8336;

MongoClient.connect(config.mongodb.database_url, (err, database) => {
  if (err) return console.log(err);

  console.log("Database connection success.");
  db = database;
  initSyscoinClient();
});

function initSyscoinClient() {

  let inputStreamError = false;
  let inputStream = fs.createReadStream(config.sys_location + "syscoin.conf");
  inputStream.on('error', function (e) {
    console.log(`Error reading syscoin.conf specified at ${config.sys_location}. Exact error is: ${JSON.stringify(e)}`);
    console.log('Syscoin.conf must be present, with rpcuser, rpcpass, and rpcport set in order to run this server.');
    process.exit();
  });

  if(!inputStreamError) {
    let lineReader = require('readline').createInterface({
      input: inputStream
    });

    //read syscoin.conf for login creds, if it doesn't exist use defaults.
    lineReader.on('line', function (line) {
      if (line.indexOf('rpcuser=') === 0) {
        rpcuser = line.substr(line.indexOf('=') + 1);
      }

      if (line.indexOf('rpcpassword=') === 0) {
        rpcpass = line.substr(line.indexOf('=') + 1);
      }

      if (line.indexOf('rpcport=') === 0) {
        rpcport = line.substr(line.indexOf('=') + 1);
      }
    });

    //init SYS API on close of config file read
    lineReader.on('close', function (line) {
      initAPI();
    });
  }

  function initAPI() {
    console.log("RPCUSER:", rpcuser);
    console.log("RPCPASS:", rpcpass);
    console.log("RPCPORT:", rpcport);

    syscoinClient = new SyscoinClient({
      host: 'localhost',
      port: rpcport,
      username: rpcuser,
      password: rpcpass,
      timeout: 30000
    });

    initApp();
  }
}

function initApp() {
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({extended: true}));

  //CORS
  app.use(cors({
    "origin": "*",
    "methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
    "preflightContinue": false //critical for proper swagger cors operations
  }));

  app.listen(config.port, () => {
    console.log(`listening on port ${config.port}`);
  });

  app.get('/', (req, res) => {
    res.send('Proxy server operational.');
  });

  app.get('/aliasdata/:aliasname', (req, res) => {
    const collection = db.collection('aliasdata');
    const aliasName = req.params.aliasname;

    console.log(`Searching for alias ${aliasName}`);
    let findFilter = {};
    try {
      findFilter._id = ObjectId(aliasName);
      console.log(`Searching for alias by id`);
    } catch(e) {
      findFilter.aliasName = aliasName;
      console.log(`Searching for alias by name`);
    }

    try {
      collection.findOne(findFilter, (err, item) => {
        if (err) res.send(`Error with request: ${err}`);

        if (item) {
          console.log(`Found result for ${aliasName}`);
          delete item._id;
          delete item.dataType;
          res.send(JSON.stringify(item));
        } else {
          console.log(`No record found for ${aliasName}`);
          res.send(`No matching records for ${aliasName}`);
        }
      });
    } catch(e) { //catch errors related to invalid id formatting
      res.send(`Error with request: ${e}`);
    }
  });

  app.post('/aliasdata/:aliasname', (req, res) => {
    const collection = db.collection('aliasdata');
    const aliasName = req.params.aliasname;

    const aliasData = JSON.parse(req.body.payload);

    const hashVerified = syscoinAuth.verifyHash(req.body.payload, req.body.hash);
    if(!hashVerified) {
      console.log(`Hashes do not match for ${aliasName}`);
      return res.send(`Hashes do not match for ${aliasName}`);
    }

    syscoinClient.aliasInfo(aliasName).then((result) => {
      if(!result && !result.address) {
        console.log(`Invalid alias ${aliasName}`);
        return res.send(`Invalid alias ${aliasName}`);
      }
      const sigVerified = syscoinAuth.verifySignature(
        req.body.hash,
        req.body.signedHash,
        result.address
      );
      if(!sigVerified) {
        console.log(`Signature verification failed for ${aliasName}`);
        return res.send(`Signature verification failed for ${aliasName}`);
      }
      try {
        aliasData.dataType = 'aliasdata';
        collection.updateOne({
          aliasName: aliasName,
          dataType: 'aliasdata'
        }, aliasData, { upsert: true }, (err) => {
          if (err) res.send(`Error with request: ${err}`);
          res.send(JSON.stringify(
            {
              storeLocations: [{
                dataUrl: `${config.base_url}/aliasdata/${aliasName}`
              }]
            }
          ));
        });
      }catch(e) { //catch errors related to invalid id formatting
        res.send(`Error with request: ${e}`);
      }
    });

  });

}

