#version 450
#pragma shader_stage(fragment)

#define SHADOW_MAP_CASCADE_COUNT 4

layout (location = 0) in vec2 TexCoords;
layout (location = 1) in vec3 WorldPos;
layout (location = 2) in vec3 Normal;
layout (location = 3) in vec3 MvWorldPos;

layout (location = 0) out vec4 FragColor;

// material parameters
layout (set = 2, binding = 0) uniform sampler2D albedoMap;
layout (set = 2, binding = 1) uniform sampler2D normalMap;
layout (set = 2, binding = 2) uniform sampler2D metallicMap;
layout (set = 2, binding = 3) uniform sampler2D roughnessMap;
layout (set = 2, binding = 4) uniform sampler2D aoMap;

// IBL
layout (set = 0, binding = 1) uniform samplerCube irradianceMap;
layout (set = 0, binding = 2) uniform samplerCube prefilterMap;
layout (set = 0, binding = 3) uniform sampler2D brdfLUT;
layout (set = 0, binding = 4) uniform sampler2DArray shadowMap;

layout (set = 0, binding = 5) uniform Cascades {
    // i can get away with vec4 because float[SHADOW_MAP_CASCADE_COUNT] -> float[4] -> vec4 and thus i don't have to deal with alignment
    vec4 cascade_splits;
    mat4 cascade_view_proj_mats[SHADOW_MAP_CASCADE_COUNT];
    vec3 light_direction;
};

// the sun :O
const vec3 lightColors[1] = vec3[1](
    vec3(1000, 1000, 1000)
);

const mat4 biasMat = mat4( 
	0.5, 0.0, 0.0, 0.0,
	0.0, 0.5, 0.0, 0.0,
	0.0, 0.0, 1.0, 0.0,
	0.5, 0.5, 0.0, 1.0 
);

layout (push_constant) uniform PushConstants {
    vec3 camPos;
};

// the rest of this is a slightly modified version of LearnOpenGL's PBR shader

const float PI = 3.14159265359;
// ----------------------------------------------------------------------------
// Easy trick to get tangent-normals to world-space to keep PBR code simplified.
// Don't worry if you don't get what's going on; you generally want to do normal 
// mapping the usual way for performance anways; I do plan make a note of this 
// technique somewhere later in the normal mapping tutorial.
vec3 getNormalFromMap()
{
    vec3 tangentNormal = texture(normalMap, TexCoords).xyz * 2.0 - 1.0;

    vec3 Q1  = dFdx(WorldPos);
    vec3 Q2  = dFdy(WorldPos);
    vec2 st1 = dFdx(TexCoords);
    vec2 st2 = dFdy(TexCoords);

    vec3 N   = normalize(Normal);
    vec3 T  = normalize(Q1*st2.t - Q2*st1.t);
    vec3 B  = -normalize(cross(N, T));
    mat3 TBN = mat3(T, B, N);

    return normalize(TBN * tangentNormal);
}
// ----------------------------------------------------------------------------
float DistributionGGX(vec3 N, vec3 H, float roughness)
{
    float a = roughness*roughness;
    float a2 = a*a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH*NdotH;

    float nom   = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;

    return nom / denom;
}
// ----------------------------------------------------------------------------
float GeometrySchlickGGX(float NdotV, float roughness)
{
    float r = (roughness + 1.0);
    float k = (r*r) / 8.0;

    float nom   = NdotV;
    float denom = NdotV * (1.0 - k) + k;

    return nom / denom;
}
// ----------------------------------------------------------------------------
float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness)
{
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    float ggx2 = GeometrySchlickGGX(NdotV, roughness);
    float ggx1 = GeometrySchlickGGX(NdotL, roughness);

    return ggx1 * ggx2;
}
// ----------------------------------------------------------------------------
vec3 fresnelSchlick(float cosTheta, vec3 F0)
{
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}
// ----------------------------------------------------------------------------
vec3 fresnelSchlickRoughness(float cosTheta, vec3 F0, float roughness)
{
    return F0 + (max(vec3(1.0 - roughness), F0) - F0) * pow(1.0 - cosTheta, 5.0);
}

float textureProj(vec4 shadowCoord, vec2 offset, uint cascadeIndex, vec3 N)
{
	float shadow = 1.0;
	//float bias = 0.005;
    float bias = 0.005 * tan(acos(clamp(dot(N, normalize(-light_direction)), 0, 1)));
    bias = clamp(bias, 0, 0.01);

	if (shadowCoord.z > -1.0 && shadowCoord.z < 1.0) {
		float dist = texture(shadowMap, vec3(shadowCoord.st + offset, cascadeIndex)).r;
		if (shadowCoord.w > 0 && dist < shadowCoord.z - bias) {
			shadow = 0; // ambient light
		}
	}

	return shadow;
}

// shadows :)
float shadow_calculation(vec3 N) {
    uint cascadeIndex = 0;
    for (uint i = 0; i < SHADOW_MAP_CASCADE_COUNT - 1; ++i) {
        if (MvWorldPos.z < cascade_splits[i]) {
            cascadeIndex = i + 1;
        }
    }

    vec4 sc = (biasMat * cascade_view_proj_mats[cascadeIndex]) * vec4(WorldPos, 1.0);
    sc = sc / sc.w;

	ivec2 texDim = textureSize(shadowMap, 0).xy;
	float scale = 0.75;
	float dx = scale * 1.0 / float(texDim.x);
	float dy = scale * 1.0 / float(texDim.y);

	float shadowFactor = 0.0;
	int count = 0;
	int range = 8;
	
	for (int x = -range; x <= range; x++) {
		for (int y = -range; y <= range; y++) {
			shadowFactor += textureProj(sc, vec2(dx*x, dy*y), cascadeIndex, N);
			count++;
		}
	}

	return shadowFactor / count;
}

void main()
{		
    // material properties
    vec3 albedo = pow(texture(albedoMap, TexCoords).rgb, vec3(2.2));
    float metallic = texture(metallicMap, TexCoords).r;
    float roughness = texture(roughnessMap, TexCoords).r;
    float ao = texture(aoMap, TexCoords).r;

    // input lighting data
    vec3 N = getNormalFromMap();
    vec3 V = normalize(camPos - WorldPos);
    vec3 R = reflect(-V, N);

    float shadow = shadow_calculation(N);
    shadow = clamp(shadow, 0, 1);

    // calculate reflectance at normal incidence; if dia-electric (like plastic) use F0 
    // of 0.04 and if it's a metal, use the albedo color as F0 (metallic workflow)    
    vec3 F0 = vec3(0.04);
    F0 = mix(F0, albedo, metallic);

    // reflectance equation
    vec3 Lo = vec3(0.0);

    // for a single directional light:
    {
        // calculate per-light radiance
        //vec3 L = normalize(lightPositions[i] - WorldPos);
        vec3 L = normalize(-light_direction); // light direction
        vec3 H = normalize(V + L);
        float distance = length(light_direction - WorldPos);
        float attenuation = 1.0 / (distance * distance);
        vec3 radiance = lightColors[0] /* * attenuation*/; // no attenuation for directional lights

        // Cook-Torrance BRDF
        float NDF = DistributionGGX(N, H, roughness);
        float G   = GeometrySmith(N, V, L, roughness);
        vec3 F    = fresnelSchlick(max(dot(H, V), 0.0), F0);
            
        vec3 nominator    = NDF * G * F;
        float denominator = 4 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.001; // 0.001 to prevent divide by zero.
        vec3 specular = nominator / denominator;
            
        // kS is equal to Fresnel
        vec3 kS = F;
        // for energy conservation, the diffuse and specular light can't
        // be above 1.0 (unless the surface emits light); to preserve this
        // relationship the diffuse component (kD) should equal 1.0 - kS.
        vec3 kD = vec3(1.0) - kS;
        // multiply kD by the inverse metalness such that only non-metals 
        // have diffuse lighting, or a linear blend if partly metal (pure metals
        // have no diffuse light).
        kD *= 1.0 - metallic;	                
                
        // scale light by NdotL
        float NdotL = max(dot(N, L), 0.0);        

        // add to outgoing radiance Lo
        Lo += (kD * albedo / PI + specular) * radiance * NdotL; // note that we already multiplied the BRDF by the Fresnel (kS) so we won't multiply by kS again
    }
    
    // ambient lighting (we now use IBL as the ambient term)
    vec3 F = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
    
    vec3 kS = F;
    vec3 kD = 1.0 - kS;
    kD *= 1.0 - metallic;	  
    
    vec3 irradiance = texture(irradianceMap, N).rgb;
    vec3 diffuse = irradiance * albedo;
    
    // sample both the pre-filter map and the BRDF lut and combine them together as per the Split-Sum approximation to get the IBL specular part.
    const float MAX_REFLECTION_LOD = 4.0;
    vec3 prefilteredColor = textureLod(prefilterMap, R, roughness * MAX_REFLECTION_LOD).rgb;    
    vec2 brdf  = texture(brdfLUT, vec2(max(dot(N, V), 0.0), roughness)).rg;
    vec3 specular = prefilteredColor * (F * brdf.x + brdf.y);

    vec3 ambient = (kD * diffuse + specular) * ao;
    
    vec3 color = ambient + Lo * shadow;

    shadow = clamp(shadow, 0.2, 1);

    color.rgb *= shadow;

    // HDR tonemapping
    color = color / (color + vec3(1.0));
    // gamma correct
    color = pow(color, vec3(1.0/2.2)); 

    FragColor = vec4(color, 1.0);
}