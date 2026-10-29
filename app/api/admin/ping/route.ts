import {NextResponse} from 'next/server';import {requireUser} from '@/lib/auth/session';import {authErrorResponse} from '@/lib/auth/guards';// Test endpoint: replace with production admin API during admin phase.
export async function GET(){try{const user=await requireUser();return NextResponse.json({role:user.role})}catch(error){return authErrorResponse(error)}}
