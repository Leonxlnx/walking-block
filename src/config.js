// Shared dimensions (meters). Walker travels along +X. Y is up.
// The walker root group sits at the BASE of the apartment block (bottom of the lowest floor slab).
// Building occupies local y >= 0, chassis (mechanical underside) occupies local y in [-CHASSIS_H, 0].
export const CFG = {
  BODY_LEN: 88,        // building length along X  (local x in [-44, 44])
  BODY_DEPTH: 15,      // building depth along Z   (local z in [-7.5, 7.5])
  FLOOR_H: 3.0,
  FLOORS: 6,           // nominal floor count (sections may vary 5..7)
  RIDE_H: 17.0,        // world y of walker root at rest
  CHASSIS_H: 4.5,      // thickness of the mechanical underside
  LEG_X: [-33, -11, 11, 33], // hip x positions (per side)
  HIP_Y: -2.6,         // hip joint local y (inside chassis band)
  HIP_Z: 9.2,          // hip joint |z|
  FOOT_Z: 23.0,        // foot home |z| (legs splay outward)
  ANKLE_H: 1.9,        // ankle joint height above ground when planted
  THIGH: 12.5,         // hip -> knee length
  SHIN: 18.0,          // knee -> ankle length
};
