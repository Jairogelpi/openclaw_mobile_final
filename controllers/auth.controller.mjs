import supabase from '../config/supabase.mjs';
import redisClient from '../config/redis.mjs';
import crypto from 'crypto';

export async function authRegister(params, id) {
    const { email, password, name } = params;

    // 1. Create user with Admin SDK to auto-confirm (Avoids 'localhost' redirect problems)
    const { data: userData, error: createError } = await supabase.auth.admin.createUser({
        email,
        password,
        user_metadata: { name },
        email_confirm: true
    });

    if (createError) throw createError;

    // 2. Sign in to get the session/token
    const { data: sessionData, error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if (loginError) throw loginError;

    // --- Generate Onboarding Session ID ---
    const onboardingSessionId = crypto.randomUUID();
    if (redisClient) {
        await redisClient.set(`onboarding_session:${sessionData.user.id}`, onboardingSessionId, { EX: 86400 }); // 24h
    }

    return {
        token: sessionData.session?.access_token,
        user: sessionData.user,
        is_onboarded: false, // New users are never onboarded yet
        onboarding_session_id: onboardingSessionId,
        message: "Account created and auto-confirmed."
    };
}


export async function authLogin(params, id) {
    const { email, password } = params;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            throw error;
        }

        // --- Generate Onboarding Session ID ---
        const onboardingSessionId = crypto.randomUUID();
        if (redisClient) {
            await redisClient.set(`onboarding_session:${data.user.id}`, onboardingSessionId, { EX: 86400 }); // 24h
        }

        // Check if onboarding was fully completed (user_souls is the ultimate proof)
        const { data: soulRecord } = await supabase
            .from('user_souls')
            .select('client_id')
            .eq('client_id', data.user.id)
            .maybeSingle();

        const isOnboarded = !!soulRecord;

        return {
            token: data.session?.access_token,
            user: data.user,
            is_onboarded: isOnboarded,
            onboarding_session_id: onboardingSessionId
        };
    } catch (err) {
        console.error('[Auth Error]', err.message);
        throw err;
    }
}
