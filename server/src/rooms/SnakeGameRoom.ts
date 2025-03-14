import { Room, Client, Delayed } from "@colyseus/core";
import { SnakeGameState, Player, Food, Vector2, SnakeSegment } from "./schema/SnakeGameState";

export class SnakeGameRoom extends Room<SnakeGameState> {
    maxClients = 20;
    tickRate = 16; // Changed from 20 to 16 ms (approximately 60 FPS)
    gameLoopInterval: Delayed;
    
    // Colors for snakes - expanded palette with 8 distinct colors
    private colors = [
        "#FF5733", // Orange (skin 0)
        "#33FF57", // Green (skin 1)
        "#3357FF", // Blue (skin 2)
        "#F3FF33", // Yellow (skin 3)
        "#FF33F3", // Pink (skin 4)
        "#33FFF3", // Cyan (skin 5)
        "#9933FF", // Purple (skin 6)
        "#FF3333"  // Red (skin 7)
    ];

    // Math constants
    private readonly PI = Math.PI;
    private readonly DEG_TO_RAD = Math.PI / 180;

    onCreate(options: any) {
        this.setState(new SnakeGameState());
        this.state.tickRate = this.tickRate;
        this.state.worldBoundaryCollisions = true;
        
        // Set up message handlers
        this.onMessage("move", (client, message: { angle: number }) => {
            const player = this.state.players.get(client.sessionId);
            if (player && player.alive) {
                player.angle = message.angle;
            }
        });

        this.onMessage("boost", (client, active: boolean) => {
            const player = this.state.players.get(client.sessionId);
            if (player && player.alive) {
                // Only allow boost if player has enough score/segments
                if (active && player.score >= 1) {
                    player.boosting = true;
                } else {
                    player.boosting = false;
                }
            }
        });

        this.onMessage("respawn", (client) => {
            this.respawnPlayer(client);
        });
        
        // Add handler for eatFood message
        this.onMessage("eatFood", (client, message: { foodId: string }) => {
            console.log(`Player ${client.sessionId} attempting to eat food ${message.foodId}`);
            
            const player = this.state.players.get(client.sessionId);
            const food = this.state.foods.get(message.foodId);
            
            // Verify that both player and food exist
            if (!player || !player.alive) {
                console.log(`Player ${client.sessionId} is not valid or not alive`);
                return;
            }
            
            if (!food) {
                console.log(`Food ${message.foodId} does not exist`);
                return;
            }
            
            // Do a basic distance check with a very generous limit
            const head = player.head;
            const dx = head.x - food.position.x;
            const dy = head.y - food.position.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            console.log(`Distance to food: ${distance}`);
            
            // Allow a very generous distance for client-side attraction
            const maxDistance = 250; // Very generous limit
            
            if (distance <= maxDistance) {
                console.log(`Player ${client.sessionId} eating food ${message.foodId}, value: ${food.value}`);
                
                // Add score
                player.score += food.value;
                console.log(`New score: ${player.score}`);
                
                // Grow snake - add more segments for special food
                const segmentsToAdd = food.value > 1 ? 3 : 1;
                for (let i = 0; i < segmentsToAdd; i++) {
                    player.addSegment();
                }
                
                // Broadcast food consumed to all clients
                this.broadcast("foodConsumed", {
                    id: message.foodId,
                    playerId: player.id,
                    value: food.value // Send the value so client knows if it was special food
                });
                
                // Remove food
                this.state.foods.delete(message.foodId);
                
                // Spawn new food
                this.spawnFood();
            } else {
                console.log(`Food too far away (${distance} > ${maxDistance})`);
            }
        });
        
        // Add handler for playground message types
        this.onMessage("*", (client, type, message) => {
            // This is a catch-all handler for any message type
            // We don't need to do anything here, but it will prevent the warning
            console.log(`Received message of type: ${type}`);
        });

        // Add this in the onCreate method
        this.onMessage("playerDied", (client, message) => {
            const player = this.state.players.get(client.sessionId);
            if (!player || !player.alive) return;
            
            // Kill the player
            this.killPlayer(player);
            
            // If there's a killer, update their score and broadcast the kill
            if (message.killerSessionId) {
                const killer = this.state.players.get(message.killerSessionId);
                if (killer) {
                    // Add score to the killer
                    killer.score += Math.floor(player.score / 2);
                    
                    // Increment kill count
                    killer.kills += 1;
                    
                    // Broadcast kill event
                    this.broadcast("playerKilled", {
                        killed: player.id,
                        killer: message.killerSessionId
                    });
                    
                    console.log(`Broadcasting kill event: ${message.killerSessionId} killed ${player.id}`);
                }
            }
            
            // Spawn food from dead player
            this.spawnFoodFromDeadPlayer(player);
        });

        // Initialize food
        this.initializeFood();
        
        // Start game loop
        this.gameLoopInterval = this.clock.setInterval(() => {
            this.gameLoop();
        }, this.tickRate);
    }

    onJoin(client: Client, options: { name: string, skinId?: number }) {
        console.log(`${client.sessionId} joined with options:`, options);
        
        // Create a new player
        const spawnPosition = this.getRandomPosition();
        
        // Use the skinId to determine the color
        const skinId = options.skinId !== undefined ? options.skinId : 0;
        const color = this.colors[skinId % this.colors.length];
        
        console.log(`Spawning player at position: ${spawnPosition.x}, ${spawnPosition.y} with color: ${color} and skin: ${skinId}`);
        
        const player = new Player(
            client.sessionId,
            options.name || `Player ${client.sessionId.substr(0, 4)}`,
            spawnPosition.x,
            spawnPosition.y,
            color
        );
        
        // Set the skinId
        player.skinId = skinId;
        
        this.state.players.set(client.sessionId, player);
        console.log(`Player created with ID: ${client.sessionId}, segments: ${player.segments.length}`);
        
        // Send a welcome message to the client
        client.send("welcome", { 
            id: client.sessionId,
            position: spawnPosition,
            color: color
        });
        
        // Send all existing food to the new client
        const initialFoods: any[] = [];
        this.state.foods.forEach((food, foodId) => {
            initialFoods.push({
                id: foodId,
                position: { x: food.position.x, y: food.position.y },
                value: food.value
            });
        });
        
        client.send("initialFoods", { foods: initialFoods });
    }

    onLeave(client: Client, consented: boolean) {
        console.log(`${client.sessionId} left!`);
        this.state.players.delete(client.sessionId);
    }

    onDispose() {
        console.log("Room disposed!");
        this.gameLoopInterval.clear();
    }

    private gameLoop() {
        const start = performance.now();
        // Update all players
        this.state.players.forEach(player => {
            if (!player.alive) return;
            
            this.movePlayer(player);
            
            // Add collision detection after moving the player
            this.checkPlayerCollisions(player);
        });
        
        // Replenish food if needed
        if (this.state.foods.size < this.state.maxFoods) {
            this.spawnFood();
        }
        const end = performance.now();
        console.log(`Game loop took ${end - start} milliseconds`);
    }

    private movePlayer(player: Player) {
        if (!player.alive || player.segments.length === 0) return;
        
        // Get the head segment
        const head = player.segments[0];
        
        // Calculate new position based on angle and speed
        // Convert degrees to radians manually instead of using Phaser
        const angleRad = player.angle * this.DEG_TO_RAD;
        
        // Apply speed boost if player is boosting
        const speedMultiplier = player.boosting ? 6 : 3; // Faster when boosting
        
        // If boosting, consume score/energy over time
        if (player.boosting) {
            player.boostTime += this.tickRate;
            
            // Consume 1 point every 500ms of boosting
            if (player.boostTime >= 500) {
                player.boostTime = 0;
                
                // Only reduce score if player has more than minimum segments
                if (player.segments.length > 5) {
                    player.score = Math.max(0, player.score - 1);
                    
                    // Remove a segment when boosting
                    if (player.segments.length > 5) {
                        player.segments.pop();
                    } else {
                        // If not enough segments, disable boosting
                        player.boosting = false;
                    }
                } else {
                    // Not enough segments to continue boosting
                    player.boosting = false;
                }
            }
        } else {
            // Reset boost timer when not boosting
            player.boostTime = 0;
        }
        
        const dx = Math.cos(angleRad) * player.speed * speedMultiplier;
        const dy = Math.sin(angleRad) * player.speed * speedMultiplier;
        
        // Create a new position for the head
        const newX = this.wrapCoordinate(head.position.x + dx, this.state.worldWidth);
        const newY = this.wrapCoordinate(head.position.y + dy, this.state.worldHeight);
        
        // Move each segment to the position of the segment in front of it
        for (let i = player.segments.length - 1; i > 0; i--) {
            const segment = player.segments[i];
            const prevSegment = player.segments[i - 1];
            
            segment.position.x = prevSegment.position.x;
            segment.position.y = prevSegment.position.y;
        }
        
        // Update the head position
        head.position.x = newX;
        head.position.y = newY;
        
        // Update the synchronized head position
        player.updateHeadPosition();
    }

    private checkPlayerCollisions(player: Player) {
        if (!player.alive) return;
        
        // Get the head position
        const head = player.segments[0];
        if (!head) return;
        
        // Check for collisions with other players
        this.state.players.forEach((otherPlayer, otherPlayerId) => {
            if (otherPlayerId === player.id || !otherPlayer.alive) return;
            
            // Skip collision check if player is invulnerable
            if (player.invulnerable) return;
            
            // Skip the head (first segment) of the other player
            for (let i = 1; i < otherPlayer.segments.length; i++) {
                const segment = otherPlayer.segments[i];
                
                // Calculate distance between player's head and other player's segment
                const dx = head.position.x - segment.position.x;
                const dy = head.position.y - segment.position.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                // Collision detected
                const headRadius = 8;
                const segmentRadius = 6;
                
                if (distance < headRadius + segmentRadius) {
                    // Kill the player
                    this.killPlayer(player);
                    
                    // Update killer's score and stats
                    otherPlayer.score += Math.floor(player.score / 2);
                    otherPlayer.kills += 1;
                    
                    // Broadcast kill event
                    this.broadcast("playerKilled", {
                        killed: player.id,
                        killer: otherPlayer.id
                    });
                    
                    // Spawn food from dead player
                    this.spawnFoodFromDeadPlayer(player);
                    
                    return; // Exit after collision is detected
                }
            }
        });
        
        // Check collision with world boundaries
        if (this.state.worldBoundaryCollisions) {
            if (head.position.x < 0 || head.position.x > this.state.worldWidth ||
                head.position.y < 0 || head.position.y > this.state.worldHeight) {
                
                // Kill the player
                this.killPlayer(player);
                
                // Broadcast death without a killer
                this.broadcast("playerDied", { 
                    playerId: player.id,
                    killerSessionId: null
                });
                
                // Spawn food from dead player
                this.spawnFoodFromDeadPlayer(player);
            }
        }
    }

    private killPlayer(player: Player) {
        player.alive = false;
        
        // Notify client that player died
        this.broadcast("playerDied", { playerId: player.id });
    }

    private respawnPlayer(client: Client) {
        const player = this.state.players.get(client.sessionId);
        if (!player) return;
        
        // Reset player
        const spawnPosition = this.getRandomPosition();
        player.alive = true;
        player.score = 0;
        player.kills = 0; // Reset kills on respawn
        player.segments.clear();
        
        // Set player as invulnerable for 3 seconds
        player.invulnerable = true;
        
        // Schedule invulnerability to end after 3 seconds
        this.clock.setTimeout(() => {
            if (player) {
                player.invulnerable = false;
            }
        }, 3000);
        
        // Initialize snake with 5 segments
        const initialSegments = 5;
        for (let i = 0; i < initialSegments; i++) {
            player.segments.push(new SnakeSegment(spawnPosition.x - i * 20, spawnPosition.y));
        }
    }

    private spawnFoodFromDeadPlayer(player: Player) {
        // Spawn food at each segment position
        const foodPerSegment = Math.min(Math.floor(player.segments.length / 3), 20);
        
        for (let i = 0; i < foodPerSegment; i++) {
            const segmentIndex = Math.floor(Math.random() * player.segments.length);
            const segment = player.segments[segmentIndex];
            
            const foodId = `food_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const foodX = segment.position.x + (Math.random() * 40 - 20);
            const foodY = segment.position.y + (Math.random() * 40 - 20);
            
            const food = new Food(
                foodId,
                foodX,
                foodY,
                1
            );
            
            this.state.foods.set(foodId, food);
            
            // Broadcast new food to all clients
            this.broadcast("foodSpawned", {
                id: foodId,
                position: { x: foodX, y: foodY },
                value: 1
            });
        }
    }

    private initializeFood() {
        // Spawn initial food
        for (let i = 0; i < this.state.maxFoods; i++) {
            this.spawnFood();
        }
    }

    private spawnFood() {
        const position = this.getRandomPosition();
        const foodId = `food_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Occasionally spawn higher value food (5% chance)
        const value = Math.random() < 0.05 ? 5 : 1;
        
        const food = new Food(foodId, position.x, position.y, value);
        this.state.foods.set(foodId, food);
        
        // Broadcast new food to all clients
        this.broadcast("foodSpawned", {
            id: foodId,
            position: { x: position.x, y: position.y },
            value: value
        });
    }

    private getRandomPosition() {
        return {
            x: Math.random() * this.state.worldWidth,
            y: Math.random() * this.state.worldHeight
        };
    }

    private wrapCoordinate(value: number, max: number): number {
        if (value < 0) return max + (value % max);
        if (value >= max) return value % max;
        return value;
    }

    // Add this method to determine who killed the player
    private getKillerSessionId(deadPlayerSessionId: string): string | null {
        const deadPlayer = this.state.players.get(deadPlayerSessionId);
        if (!deadPlayer) return null;
        
        const headPosition = deadPlayer.segments[0].position;
        const collisionRadius = 10; // Same as headRadius in checkPlayerCollisions
        
        // Check if player collided with another player's body
        for (const [sessionId, player] of this.state.players.entries()) {
            if (sessionId === deadPlayerSessionId) continue;
            
            // Check if dead player's head collided with this player's body
            // Skip the head (index 0) to match the collision logic in checkPlayerCollisions
            for (let i = 1; i < player.segments.length; i++) {
                const segment = player.segments[i];
                const dx = headPosition.x - segment.position.x;
                const dy = headPosition.y - segment.position.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                if (distance < collisionRadius + 8) { // 8 is approximate segment radius
                    return sessionId;
                }
            }
        }
        
        return null;
    }
} 