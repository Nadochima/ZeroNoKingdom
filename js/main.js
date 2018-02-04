//NOTES:
//timestamp unit is 5 minutes

class Page extends ZeroFrame {
  setSiteInfo(site_info) {
    this.site_info = site_info;
    this.game_chain.handleSiteInfo(this.site_info); //handle site_info event

    //listen to config changes
    if(this.site_info.event){
      if(this.site_info.event[0] == "file_done" && this.site_info.event[1] == "config.json")
        this.loadConfig();
    }

    //detect login change
    if(this.login != site_info.cert_user_id){
      this.login = site_info.cert_user_id;

      if(this.site_info.cert_user_id)
        this.e_user.innerHTML = this.site_info.cert_user_id;
      else
        this.e_user.innerHTML = "login...";

      this.refresh();
    }
  }

  loadConfig(){
    var _this = this;
    this.cmd("fileGet", { inner_path: "config.json" }, function(data){
      if(data){
        _this.cfg = JSON.parse(data);
        _this.game_chain.to_build = true; //rebuild chain when the config changes
      }
    });
  }

  onOpenWebsocket() {
    var _this = this;

    this.e_user = document.getElementById("user");
    this.e_user.onclick = function(e){
      e.preventDefault();
      _this.cmd("certSelect", {});
    }

    this.e_game = document.getElementById("game");

    //init 
    this.cmd("siteInfo", [], function(site_info) {
      _this.setSiteInfo(site_info)
    })

    this.loadConfig();

    //game data
    this.buildings = {
      city_hall: { 
        max_lvl: 5, //other buildings have a max_lvl of the city_hall lvl
        build_factor: 4, //time/resources base factor (factor^(target_lvl-1)*required to build)
        build_time: 1,
        build_resources: {
          wood: 200
        }
      },
      sawmill: {
        build_factor: 2,
        build_time: 1,
        build_resources: {
          wood: 100
        },
        produce_resources: { //resource produced per time unit
          wood: 10
        }
      }
    }

    //setup chain
    this.game_chain = new zchain("game", this);

    this.check_acts = {
      build: function(state, block, player_data, data){
        //build order
        var base = _this.buildings[data.building || ""];
        if(base){
          var building = state.computeBuilding(block.owner, data.building, block.data.timestamp);

          //check in construction
          if(building.in_construction)
            return false;

          //check maxlvl
          if(base.max_lvl != null){
            if(building.lvl+1 > base.max_lvl)
              return false;
          }
          else{ //or based on city hall
            var city_hall = state.computeBuilding(block.owner, "city_hall", block.data.timestamp);
            if(building.lvl+1 > city_hall.lvl)
              return false;
          }

          //check resource cost
          var factor = Math.pow(base.build_factor,building.lvl); //+1-1
          for(var resource in base.build_resources){
            if(state.computeResource(block.owner, resource, block.data.timestamp) < base.build_resources[resource]*factor)
              return false;
          }

          return true;
        }
      }
    }

    this.process_acts = {
      build: function(state, block, player_data, data){
        var base = _this.buildings[data.building];
        var building = state.computeBuilding(block.owner, data.building, block.data.timestamp);

        //consume build resources
        var factor = Math.pow(base.build_factor, building.lvl); //+1-1
        for(var resource in base.build_resources)
          state.varyResource(block.owner, resource, -base.build_resources[resource]*factor);

        //add previously generated resources (remember production)
        if(building.order_timestamp != null){
          var factor = Math.pow(base.build_factor,building.lvl-1); 
          for(var resource in base.produce_resources){
            var amount = base.produce_resources[resource];
            if(amount > 0)
              state.varyResource(block.owner, resource, factor*amount*(block.data.timestamp-building.order_timestamp));
          }
        }

        player_data.buildings[data.building] = {lvl: building.lvl, order_timestamp: block.data.timestamp};
      }
    }

    this.check_types = {
      snapshot: function(state, block){
        if(!block.prev_block){ //check chain origin
          return true;
        }
      },
      register: function(state, block){
        if(!state.players[block.owner])
          return (typeof block.data.city_name == "string"
            && block.data.city_name.length > 0 
            && block.data.city_name.length <= 50);
      },
      actions: function(state, block){
        // process actions
        var player_data = state.players[block.owner];

        var acts = block.data.actions;
        if(player_data && Array.isArray(acts)){
          for(var i = 0; i < acts.length; i++){
            var act = acts[i];
            if(act.length != 2)
              return false;

            var cb = _this.check_acts[act[0]];
            if(cb){
              var ok = cb(state, block, player_data, act[1]);
              if(!ok)
                return false;
            }
            else
              return false;
          }

          return true;
        }
      }
    }

    this.process_types = {
      snapshot: function(state, block){
      },
      register: function(state, block){
        //init player data
        state.players[block.owner] = {
          city_name: block.data.city_name, 
          register_timestamp: block.data.timestamp,
          resources: {
            wood: 500
            //...
          },
          buildings: {},
          units: {}
        }
      },
      actions: function(state, block){
        var player_data = state.players[block.owner];
        var acts = block.data.actions;
        for(var i = 0; i < acts.length; i++){
          var act = acts[i];
          _this.process_acts[act[0]](state, block, player_data, act[1]);
        }
      }
    }

    //prechecks
    this.game_chain.addPreCheckCallbacks(function(auth_address){
      //precheck user
      
      //check banned users
      if(_this.cfg && _this.cfg.bans[auth_address])
        return false;
      
      return true;
    }, null);

    //build
    this.game_chain.addBuildCallback(function(state, pre){
      if(pre){ //pre build
        //init data/state
        state.players = {}

        //state API
        //return {lvl: current lvl, in_construction: true/false, order_timestamp: next or previous build timestamp}
        state.computeBuilding = function(user, name, timestamp){
          var player = this.players[user];
          var r = {lvl: 0, in_construction: false}
          if(player){
            var building = player.buildings[name];
            var base = _this.buildings[name];
            if(building){
              r.lvl = building.lvl;
              if(building.order_timestamp != null){
                r.order_timestamp = building.order_timestamp;
                if(timestamp >= building.order_timestamp)
                  r.lvl++;
                else
                  r.in_construction = true;
              }
            }
          }

          return r;
        }

        state.computeResource = function(user, resource, timestamp){
          var player = this.players[user];
          var amount = 0;
          if(player){
            //compute production
            for(var name in player.buildings){
              var base = _this.buildings[name];
              if(base.produce_resources){
                var produced = base.produce_resources[resource];
                if(produced > 0){
                  var building = this.computeBuilding(user, name, timestamp);
                  var factor = Math.pow(base.build_factor,building.lvl-1);
                  if(!building.in_construction)
                    amount += factor*produced*(timestamp-building.order_timestamp);
                }
              }
            }

            //add balance
            if(player.resources[resource] != null)
              amount += player.resources[resource];
          }

          return amount;
        }

        state.varyResource = function(user, resource, amount){
          var player = this.players[user];
          player.resources[resource] = (player.resources[resource] ? player.resources[resource] : 0)+amount;
        }
      }
      else{ //post build
        _this.refresh();
      }
    });

    //check block
    this.game_chain.addCheckCallback(function(state, block){
      //check chain origin
      if(!block.prev_block && _this.cfg && block.hash == _this.cfg.chain_origin)
        return true;

      //timestamp check (blocks must have a valid timestamp)
      if(block.data.timestamp == null 
        || block.data.timestamp > _this.current_timestamp 
        || (block.prev_block.data.timestamp != null && block.data.timestamp < block.prev_block.data.timestamp))
        return false;

      //type checks
      if(block.data.type){
        var cb = _this.check_types[block.data.type];
        if(cb)
          return cb(state, block);
      }
    });

    //process block
    this.game_chain.addProcessCallback(function(state, block){
      //type process
      if(block.data.type){
        var cb = _this.process_types[block.data.type];
        if(cb)
          return cb(state, block);
      }
    });

    this.game_chain.load();

    //rebuild chain every 1.5 seconds (if no files has been updated, it's a boolean check).
    setInterval(function(){ 
      _this.current_timestamp = Math.floor(new Date().getTime()/300000);
      _this.game_chain.build();
    }, 1500); 
  }

  onRequest(cmd, message) {
    if (cmd == "setSiteInfo")
      this.setSiteInfo(message.params)
    else
      this.log("Unknown incoming message:", cmd)
  }

  refresh(){
    var _this = this;
    var state = this.game_chain.state;

    this.e_game.innerHTML = "";

    if(this.game_chain.stats.built_hash){
      if(this.site_info.cert_user_id){
        var user = this.site_info.auth_address;
        var player = state.players[user];
        if(player){
          var e_infos = document.createElement("textarea");
          e_infos.style.width = "800px";
          e_infos.style.height = "200px";

          //display city info
          e_infos.innerHTML += "city name: "+player.city_name;

          var disp_resource = function(name){
            e_infos.innerHTML += "\n"+name+": "+state.computeResource(user, name, _this.current_timestamp);
          }

          //display resources
          e_infos.innerHTML += "\n\n= RESOURCES ="
          disp_resource("wood");
          disp_resource("stone");
          disp_resource("iron");
          this.e_game.appendChild(e_infos);

          var disp_building = function(name){
            var building = state.computeBuilding(user, name, _this.current_timestamp);
            var e_up = document.createElement("input");
            e_up.type = "button";
            e_up.onclick = function(){
              _this.game_chain.push({ type: "actions", timestamp: _this.current_timestamp, actions: [["build", {building: name}]]});
            }
            e_up.value = "UP "+name;

            _this.e_game.appendChild(document.createElement("br"));
            _this.e_game.appendChild(e_up);
            _this.e_game.appendChild(document.createTextNode("lvl = "+building.lvl+" in_construction = "+building.in_construction));
          }

          disp_building("city_hall");
          disp_building("sawmill");
        }
        else{
          //city creation
          var e_name = document.createElement("input");
          e_name.type = "text";
          e_name.placeholder = "city name (0-50)";
          var e_valid = document.createElement("input");
          e_valid.type = "button";
          e_valid.value = "create city";
          e_valid.onclick = function(){
            if(e_name.value.length > 0 && e_name.value.length <= 50)
              _this.game_chain.push({type: "register", timestamp: _this.current_timestamp, city_name: e_name.value});
            else
              alert("Invalid number of characters.");
          }

          this.e_game.appendChild(e_name);
          this.e_game.appendChild(e_valid);
        }
      }
      else
        this.e_game.appendChild(document.createTextNode("Not logged."));
    }
    else
      this.e_game.appendChild(document.createTextNode("Chain not loaded."));
  }
}

page = new Page(); //init page
