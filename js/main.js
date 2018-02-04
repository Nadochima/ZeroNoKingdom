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
          var building = state.computeBuilding(block.owner, data.building, block.timestamp);

          //check in construction
          if(building.in_construction)
            return false;
          
          //check maxlvl
          if(base.max_lvl != null){
            if(building.lvl+1 > base.max_lvl)
              return false;
          }
          else{ //or based on city hall
            var city_hall = sate.computeBuilding(block.owner, "city_hall", block.timestamp);
            if(building.lvl+1 > city_hall.lvl)
              return false;
          }

          //check resource cost
          var factor = base.build_factor^(building.lvl); //+1-1
          for(var resource in base.build_resources){
            if(state.computeResource(block.owner, resource, block.timestamp) < base.build_resources[resource]*factor)
              return false;
          }

          return true;
        }
      }
    }

    this.process_acts = {
      build: function(state, block, player_data, data){
        var base = _this.buildings[data.building];
        var building = state.computeBuilding(block.owner, data.building, block.timestamp);

        //consume build resources
        var factor = base.build_factor^(building.lvl); //+1-1
        for(var resource in base.build_resources)
          state.varyResource(block.owner, resource, base.build_resources[resource]*factor);

        //add previously generated resources (remember production)
        if(building.order_timestamp != null){
          var factor = base.build_factor^(building.lvl-1); 
          for(var resource in base.produce_resources){
            var amount = base.produce_resources[resource];
            if(amount > 0)
              state.varyResource(block.owner, resource, factor*amount*(block.timestamp-building.order_timestamp));
          }
        }

        player_data.buildings[data.building] = {lvl: building.lvl+1, order_timestamp: block.timestamp};
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

            var cb = _this.check_acts[acts[0]];
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
        _this.current_timestamp = Math.floor(new Date().getTime()/300000);
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
                if(building.order_timestamp >= timestamp)
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
              var produced = base.produce_resources[resource];
              if(produced > 0){
                var building = this.computeBuilding(user, name, timestamp);
                var factor = base.build_factor^(building.lvl-1);
                if(!building.in_construction)
                  amount += factor*produced*(timestamp-building.order_timestamp);
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
      }
    });

    //check block
    this.game_chain.addCheckCallback(function(state, block){
      //check chain origin
      if(!block.prev_block && _this.cfg && block.hash == _this.cfg.chain_origin)
        return true;

      //timestamp check (blocks must have a valid timestamp)
      if(block.timestamp == null 
        || block.timestamp > _this.current_timestamp 
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
      _this.game_chain.build();
    }, 1500); 
  }

  onRequest(cmd, message) {
    if (cmd == "setSiteInfo")
      this.setSiteInfo(message.params)
    else
      this.log("Unknown incoming message:", cmd)
  }
}

page = new Page(); //init page
