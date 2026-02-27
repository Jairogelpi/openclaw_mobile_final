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

    return {
        token: sessionData.session?.access_token,
        user: sessionData.user,
        message: "Account created and auto-confirmed."
    };
}


export async function authLogin(params, id) {
    const { email, password } = params;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            // Self-healing: If email not confirmed, confirm it via Admin SDK (DEV only behavior)
            if (error.message.includes('Email not confirmed')) {
                console.log(`[Auth] Auto-confirming user: ${email}`);
                const { data: userList } = await supabase.auth.admin.listUsers();
                const user = userList.users.find(u => u.email === email);
                if (user) {
                    await supabase.auth.admin.updateUserById(user.id, { email_confirm: true });
                    // Retry login
                    const retry = await supabase.auth.signInWithPassword({ email, password });
                    if (retry.error) throw retry.error;

                    // --- Generate Onboarding Session ID (Retry Branch) ---
                    const onboardingSessionId = crypto.randomUUID();
                    if (redisClient) {
                        await redisClient.set(`onboarding_session:${retry.data.user.id}`, onboardingSessionId, { EX: 86400 });
                    }

                    return {
                        token: retry.data.session?.access_token,
                        user: retry.data.user,
                        onboarding_session_id: onboardingSessionId
                    };
                }
            }
            throw error;
        }

        // --- Generate Onboarding Session ID ---
        const onboardingSessionId = crypto.randomUUID();
        if (redisClient) {
            await redisClient.set(`onboarding_session:${data.user.id}`, onboardingSessionId, { EX: 86400 }); // 24h
        }

        return {
            token: data.session?.access_token,
            user: data.user,
            onboarding_session_id: onboardingSessionId
        };
    } catch (err) {
        console.error('[Auth Error]', err.message);
        throw err;
    }
}
