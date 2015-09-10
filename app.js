var fs = require('fs');
var path = require('path');
var storage = require('node-persist');
var hap = require('HAP-NodeJS');
var uuid = require('HAP-NodeJS').uuid;
var Bridge = require('HAP-NodeJS').Bridge;
var Accessory = require('HAP-NodeJS').Accessory;
var Service = require('HAP-NodeJS').Service;
var Characteristic = require('HAP-NodeJS').Characteristic;
var accessoryLoader = require('HAP-NodeJS').AccessoryLoader;
var once = require('HAP-NodeJS/lib/util/once').once;
var npm = require('npm');

console.log("Starting HomeBridge server...");

console.log("_____________________________________________________________________");
console.log("IMPORTANT: Homebridge is in the middle of some big changes.");
console.log("           Read more about it here:");
console.log("           https://github.com/nfarina/homebridge/wiki/Migration-Guide");
console.log("_____________________________________________________________________");
console.log("");

// Look for the configuration file
var configPath = path.join(__dirname, "config.json");

// Complain and exit if it doesn't exist yet
if (!fs.existsSync(configPath)) {
    console.log("Couldn't find a config.json file in the same directory as app.js. Look at config-sample.json for examples of how to format your config.js and add your home accessories.");
    process.exit(1);
}

// Initialize HAP-NodeJS
hap.init();

// Load up the configuration file
var config;
try {
  config = JSON.parse(fs.readFileSync(configPath));
}
catch (err) {
  console.log("There was a problem reading your config.json file.");
  console.log("Please try pasting your config.json file here to validate it: http://jsonlint.com");
  console.log("");
  throw err;
}

// pull out our custom Bridge settings from config.json, if any
var bridgeConfig = config.bridge || {};

// Start by creating our Bridge which will host all loaded Accessories
var bridge = new Bridge(bridgeConfig.name || 'Homebridge', uuid.generate("HomeBridge"));

// keep track of async calls we're waiting for callbacks on before we can start up
// this is hacky but this is all going away once we build proper plugin support
var asyncCalls = 0;
var asyncWait = false;

function startup() {
    asyncWait = true;
    if (config.platforms) loadPlatforms();
    if (config.accessories) loadAccessories();  // this doesn't work any more
    asyncWait = false;
    
    // publish now unless we're waiting on anyone
    if (asyncCalls == 0)
      publish();
}

function loadAccessories() {

    // Instantiate all accessories in the config
    console.log("Loading " + config.accessories.length + " accessories...");
    
    for (var i=0; i<config.accessories.length; i++) {

        var accessoryConfig = config.accessories[i];

        // Load up the class for this accessory
        var accessoryType = accessoryConfig["accessory"]; // like "WeMo"
        var accessoryModule = require('./accessories/' + accessoryType + ".js"); // like "./accessories/WeMo.js"
        var accessoryConstructor = accessoryModule.accessory; // like "WeMoAccessory", a JavaScript constructor

        // Create a custom logging function that prepends the device display name for debugging
        var accessoryName = accessoryConfig["name"];
        var log = createLog(accessoryName);

        log("Initializing %s accessory...", accessoryType);
        
        var accessoryInstance = new accessoryConstructor(log, accessoryConfig);
        var accessory = createAccessory(accessoryInstance, accessoryName);
        
        // add it to the bridge
        bridge.addBridgedAccessory(accessory);
    }
}

function loadPlatforms() {

    console.log("Loading " + config.platforms.length + " platforms...");

    for (var i=0; i<config.platforms.length; i++) {

        var platformConfig = config.platforms[i];

        // Load up the class for this accessory
        var platformType = platformConfig["platform"]; // like "Wink"
        var platformName = platformConfig["name"];
        // and here we need to install the platform dependencies
        // proudly copied the example from the npmi readme github.com/maxleiko/npmi
        var npmi = require('npmi');
        var path = require('path');

        console.log(npmi.NPM_VERSION); // prints the installed npm version used by npmi


        var options = {
            name: platformType,    // your module name
            //version: '0.0.1',       // expected version [default: 'latest']
            path: '.',              // installation path [default: '.']
            forceInstall: false,    // force install if set to true (even if already installed, it will do a reinstall) [default: false]
            npmLoad: {              // npm.load(options, callback): this is the "options" given to npm.load()
                loglevel: 'info'  // [default: {loglevel: 'silent'}]
            }
        };

        
        npmi(options, function (err, result) {
            if (err) {
                if      (err.code === npmi.LOAD_ERR)  {
                	console.log('npm load error');
                }  else if (err.code === npmi.INSTALL_ERR) {
                	console.log('npm install error');
                }
                //return console.log(err.message);  // let it fail and show!!!! 
                throw new Error("npmi failed to install " + options.name);
            }
            // installed
            console.log(options.name+'@'+options.version+' installed successfully in '+path.resolve(options.path));
            // is installed, but the dependencies might still be missing
            //var platformModule = require('./platforms/' + platformType + ".js"); // like "./platforms/Wink.js"
            var platformModule = require(platformType);
            // why is this done in two steps?
            var platformConstructor = platformModule.platform; // like "WinkPlatform", a JavaScript constructor

            // Create a custom logging function that prepends the platform name for debugging
            var log = createLog(platformName);

            log("Initializing %s platform...", platformType);

            var platformInstance = new platformConstructor(log, platformConfig);
            loadPlatformAccessories(platformInstance, log);
        });
    } // end for
}

function loadPlatformAccessories(platformInstance, log) {
  asyncCalls++;
  platformInstance.accessories(once(function(foundAccessories){
      asyncCalls--;
      
      // loop through accessories adding them to the list and registering them
      for (var i = 0; i < foundAccessories.length; i++) {
          var accessoryInstance = foundAccessories[i];
          var accessoryName = accessoryInstance.name; // assume this property was set
          
          log("Initializing platform accessory '%s'...", accessoryName);
          
          var accessory = createAccessory(accessoryInstance, accessoryName);

          // add it to the bridge
          bridge.addBridgedAccessory(accessory);
      }
      
      // were we the last callback?
      if (asyncCalls === 0 && !asyncWait)
        publish();
  }));
}

function createAccessory(accessoryInstance, displayName) {
  
  var services = accessoryInstance.getServices();
  
  if (!(services[0] instanceof Service)) {
    // The returned "services" for this accessory is assumed to be the old style: a big array
    // of JSON-style objects that will need to be parsed by HAP-NodeJS's AccessoryLoader.

    // Create the actual HAP-NodeJS "Accessory" instance
    return accessoryLoader.parseAccessoryJSON({
      displayName: displayName,
      services: services
    });
  }
  else {
    // The returned "services" for this accessory are simply an array of new-API-style
    // Service instances which we can add to a created HAP-NodeJS Accessory directly.
    
    var accessoryUUID = uuid.generate(accessoryInstance.constructor.name + ":" + displayName);
    
    var accessory = new Accessory(displayName, accessoryUUID);
    
    // listen for the identify event if the accessory instance has defined an identify() method
    if (accessoryInstance.identify)
      accessory.on('identify', function(paired, callback) { accessoryInstance.identify(callback); });
    
    services.forEach(function(service) {
      
      // if you returned an AccessoryInformation service, merge its values with ours
      if (service instanceof Service.AccessoryInformation) {
        var existingService = accessory.getService(Service.AccessoryInformation);
        
        // pull out any values you may have defined
        var manufacturer = service.getCharacteristic(Characteristic.Manufacturer).value;
        var model = service.getCharacteristic(Characteristic.Model).value;
        var serialNumber = service.getCharacteristic(Characteristic.SerialNumber).value;
        
        if (manufacturer) existingService.setCharacteristic(Characteristic.Manufacturer, manufacturer);
        if (model) existingService.setCharacteristic(Characteristic.Model, model);
        if (serialNumber) existingService.setCharacteristic(Characteristic.SerialNumber, serialNumber);
      }
      else {
        accessory.addService(service);
      }
    });
    
    return accessory;
  }
}

// Returns a logging function that prepends messages with the given name in [brackets].
function createLog(name) {
  return function(message) {
    var rest = Array.prototype.slice.call(arguments, 1 ); // any arguments after message
    var args = ["[%s] " + message, name].concat(rest);
    console.log.apply(console, args);
  }
}

function publish() {
  bridge.publish({
    username: bridgeConfig.username || "CC:22:3D:E3:CE:30",
    port: bridgeConfig.port || 51826,
    pincode: bridgeConfig.pin || "031-45-154",
    category: Accessory.Categories.OTHER
  });
}

startup();
