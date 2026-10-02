"use client";

import { Float, MeshTransmissionMaterial } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";

/**
 * One static-feeling hero: a glass credential tile with a stamped check, lit by
 * two restrained directional lights. `frameloop="demand"` keeps the cost near
 * zero because nothing animates except the drei float, and the whole scene is
 * only mounted when WebGL exists and reduced motion is off.
 */
export function CredentialScene() {
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.5]}
      camera={{ position: [0, 0, 4.2], fov: 38 }}
      gl={{ antialias: true, alpha: true }}
      aria-hidden
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 4, 5]} intensity={1.1} />
      <directionalLight position={[-4, -2, -3]} intensity={0.35} color="#8ab4ff" />
      <Suspense fallback={null}>
        <Float speed={1.1} rotationIntensity={0.25} floatIntensity={0.6}>
          <group rotation={[0.1, -0.35, 0.04]}>
            <mesh>
              <boxGeometry args={[2.1, 1.32, 0.08]} />
              <MeshTransmissionMaterial
                thickness={0.35}
                roughness={0.28}
                transmission={0.92}
                ior={1.3}
                chromaticAberration={0.02}
                backside={false}
              />
            </mesh>
            <mesh position={[0, 0, 0.06]}>
              <boxGeometry args={[1.78, 0.1, 0.01]} />
              <meshBasicMaterial color="#5b8cff" />
            </mesh>
            <mesh position={[-0.62, 0.34, 0.06]}>
              <boxGeometry args={[0.5, 0.08, 0.01]} />
              <meshBasicMaterial color="#9aa7bd" />
            </mesh>
            <mesh position={[0.78, -0.36, 0.06]}>
              <ringGeometry args={[0.14, 0.19, 40]} />
              <meshBasicMaterial color="#3fbf7f" />
            </mesh>
          </group>
        </Float>
      </Suspense>
    </Canvas>
  );
}
