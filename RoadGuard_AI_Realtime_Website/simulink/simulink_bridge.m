%% MathWorks MATLAB / Simulink Co-Simulation Bridge for RoadGuard AI
% Connects MATLAB/Simulink with the RoadGuard Autonomous Navigation & Path Planner Engine
% Compatible with MATLAB R2022b+ (Automated Driving Toolbox & Navigation Toolbox)

function simulink_bridge()
    fprintf('=== ROADGUARD AI <-> MATLAB/SIMULINK CO-SIMULATION BRIDGE ===\n');
    baseUrl = 'http://127.0.0.1:5000';
    
    % 1. Check API readiness
    try
        resp = webread([baseUrl '/api/autonomous/simulink/model-spec']);
        fprintf('[OK] Connected to RoadGuard AI Simulink Engine: %s\n', resp.model_name);
        disp(resp.parameters);
    catch ME
        fprintf('[ERROR] Could not reach RoadGuard server at %s. Please start app.py first.\n', baseUrl);
        return;
    end

    % 2. Run closed-loop stepping example
    simTime = 10.0; % seconds
    dt = 0.05;      % 20 Hz
    nSteps = floor(simTime / dt);
    
    fprintf('[SIM] Running closed-loop trajectory tracking for %.1f s...\n', simTime);
    
    for k = 1:nSteps
        % Generate sample lateral steering command (e.g. sinusoidal obstacle bypass)
        t = (k-1) * dt;
        if t > 2.0 && t < 5.0
            steering_cmd = 12.0 * sin(2 * pi * (t - 2.0) / 3.0);
            risk = 'CAUTION';
        else
            steering_cmd = 0.0;
            risk = 'NORMAL';
        end
        target_v = 11.1; % ~40 km/h
        
        payload = struct('steering_deg', steering_cmd, ...
                         'target_velocity_mps', target_v, ...
                         'dt', dt, ...
                         'risk_level', risk);
        
        options = weboptions('MediaType', 'application/json', 'RequestMethod', 'post');
        stepRes = webwrite([baseUrl '/api/autonomous/simulink/run-step'], payload, options);
        
        if mod(k, 20) == 0
            fprintf('Time: %.2fs | X: %.2fm, Y: %.2fm | Lat_g: %.2f | Stateflow: %s\n', ...
                t, stepRes.state.x, stepRes.state.y, stepRes.state.lateral_accel_g, stepRes.stateflow_state);
        end
        pause(dt);
    end
    
    fprintf('[COMPLETE] Co-Simulation finished successfully.\n');
end
