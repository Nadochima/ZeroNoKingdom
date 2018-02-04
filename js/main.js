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
        max_lvl: 5, //other buildings have a max_lvl of city_hall lvl*5
        build_factor: 3, //time/resources base factor (factor^lvl*required to build)
        build_time: 4,
        build_resources: {
          wood: 200
        }
      }
    }

    //setup chain
    this.game_chain = new zchain("game", this);

    this.check_acts = {
      build: function(state, block, data){
        var cfg_building = _this.buildings[data.building || ""];
      }
    }

    this.process_acts = {
      build: function(state, block, data){
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
        var acts = block.data.actions;
        if(Array.isArray(acts)){
          for(var i = 0; i < acts.length; i++){
            var act = acts[i];
            if(act.length != 2)
              return false;

            var cb = _this.check_acts[acts[0]];
            if(cb){
              var ok = cb(state, block, act[1]);
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
          resources_trs: {},
          building_trs: {},
          units: {}
        }
      },
      actions: function(state, block){
        var acts = block.data.actions;
        for(var i = 0; i < acts.length; i++){
          var act = acts[i];
          _this.process_acts[act[0]](state, block, act[1]);
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
        _this.current_timestamp = Math.floor(new Date().getTime()/300000);
        state.players = {}
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
