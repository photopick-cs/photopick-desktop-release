import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const releaseTag = process.env.RELEASE_TAG;
const releaseId = process.env.RELEASE_ID;
const isManualTrigger = process.env.MANUAL_TRIGGER === 'true';

const supabase = createClient(supabaseUrl, supabaseKey);

async function syncReleaseToSupabase() {
    try {
        console.log(`🔄 Syncing release ${releaseTag} to Supabase...`);
        console.log(`📋 Trigger type: ${isManualTrigger ? 'Manual' : 'Automatic'}`);

        // 환경변수 체크
        if (!supabaseUrl || !supabaseKey) {
            throw new Error('Missing Supabase credentials');
        }

        // 1. GitHub API로 릴리즈 정보 가져오기
        let release;

        if (releaseId && !isManualTrigger) {
            // 자동 트리거: releaseId로 직접 조회
            release = await fetchReleaseById(releaseId);
        } else {
            // 수동 트리거: tag로 릴리즈 조회
            release = await fetchReleaseByTag(releaseTag);
        }

        if (!release) {
            throw new Error(`Release not found: ${releaseTag}`);
        }

        console.log(`📦 Found release: ${release.name || release.tag_name}`);
        console.log(`📁 Assets: ${release.assets.length}`);
        console.log(`📄 Status: ${release.draft ? 'Draft' : 'Published'}`);

        // Draft 릴리즈는 건너뛰기
        if (release.draft) {
            console.log('⏭️  Skipping draft release');
            return;
        }

        // 2. 각 플랫폼별 Asset 처리
        let processedCount = 0;
        for (const asset of release.assets) {
            if (isAppAsset(asset)) {
                await processAsset(asset, release);
                processedCount++;
            }
        }

        if (processedCount === 0) {
            console.log('⚠️  No app assets found in release');
            return;
        }

        console.log(`✅ Successfully synced ${processedCount} assets to Supabase`);
    } catch (error) {
        console.error('❌ Failed to sync to Supabase:', error);
        process.exit(1);
    }
}

async function fetchReleaseById(releaseId) {
    console.log(`🔍 Fetching release by ID: ${releaseId}`);

    const response = await fetch(
        `https://api.github.com/repos/sjly3k/eyeopen-desktop/releases/${releaseId}`,
        {
            headers: {
                Authorization: `token ${process.env.GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json',
            },
        },
    );

    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
}

async function fetchReleaseByTag(tag) {
    console.log(`🔍 Fetching release by tag: ${tag}`);

    const response = await fetch(
        `https://api.github.com/repos/sjly3k/eyeopen-desktop/releases/tags/${tag}`,
        {
            headers: {
                Authorization: `token ${process.env.GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json',
            },
        },
    );

    if (!response.ok) {
        if (response.status === 404) {
            console.error(`❌ Release not found for tag: ${tag}`);
            return null;
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
}

function isAppAsset(asset) {
    const appExtensions = ['.dmg', '.exe', '.AppImage', '.deb', '.rpm'];
    const excludedPatterns = ['.blockmap', '.yml', '.yaml', '.json', '.txt', '.md'];

    // 제외할 패턴이 포함된 파일은 건너뛰기
    if (excludedPatterns.some((pattern) => asset.name.toLowerCase().includes(pattern))) {
        return false;
    }

    // 앱 파일 확장자가 포함된 파일만 허용
    return appExtensions.some((ext) => asset.name.toLowerCase().includes(ext));
}

async function processAsset(asset, release) {
    const platform = detectPlatform(asset.name);
    const architecture = detectArchitecture(asset.name);

    console.log(`📦 Processing ${asset.name} (${platform}-${architecture})`);

    // SHA512 해시 계산 (yml 파일에서 가져오거나 직접 계산)
    const sha512 = await getSHA512FromYml(asset, release);

    // Supabase에 버전 정보 저장
    const versionData = {
        version: release.tag_name.replace('v', ''),
        platform,
        architecture,
        file_name: asset.name,
        download_url: asset.browser_download_url,
        file_size: asset.size,
        sha512,
        release_notes: release.body || `Version ${release.tag_name}`,
        github_release_id: release.id,
        github_asset_id: asset.id,
        created_at: release.published_at || release.created_at,
        updated_at: new Date().toISOString(),
        is_latest: true,
    };

    const { error } = await supabase.from('app_versions').upsert(versionData, {
        onConflict: 'version,platform,architecture',
    });

    if (error) {
        throw new Error(`Failed to upsert ${asset.name}: ${error.message}`);
    }

    // 이전 버전들의 is_latest를 false로 업데이트
    await supabase
        .from('app_versions')
        .update({ is_latest: false })
        .eq('platform', platform)
        .eq('architecture', architecture)
        .neq('version', release.tag_name.replace('v', ''));

    console.log(`✅ Processed ${asset.name}`);
}

function detectPlatform(fileName) {
    if (fileName.includes('.dmg')) return 'darwin';
    if (fileName.includes('.exe')) return 'win32';
    if (fileName.includes('.AppImage') || fileName.includes('.deb')) return 'linux';
    return 'unknown';
}

function detectArchitecture(fileName) {
    if (fileName.includes('arm64')) return 'arm64';
    if (fileName.includes('x64') || fileName.includes('x86_64')) return 'x64';
    if (fileName.includes('ia32') || fileName.includes('i386')) return 'ia32';
    return 'x64'; // default
}

async function getSHA512FromYml(asset, release) {
    try {
        // yml 파일에서 SHA512 찾기 시도
        const assetName = asset.name;
        const assetPlatform = assetName.includes('arm64') ? 'arm64' : 'x64';

        const ymlAsset = release.assets.find((a) => a.name === `latest-${assetPlatform}-mac.yml`);

        if (ymlAsset) {
            console.log(`🔍 Found yml file: ${ymlAsset.name}, extracting SHA512...`);
            console.log(`📥 YML download URL: ${ymlAsset.browser_download_url}`);

            // GitHub API를 통해 yml 파일 내용 가져오기
            const ymlResponse = await fetch(
                `https://api.github.com/repos/sjly3k/eyeopen-desktop/releases/assets/${ymlAsset.id}`,
                {
                    headers: {
                        Authorization: `token ${process.env.GITHUB_TOKEN}`,
                        Accept: 'application/octet-stream',
                    },
                },
            );

            if (!ymlResponse.ok) {
                throw new Error(
                    `Failed to fetch yml file: ${ymlResponse.status} ${ymlResponse.statusText}`,
                );
            }

            const content = await ymlResponse.text();
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.includes(`url: ${assetName}`)) {
                    console.log(`✅ Found matching url line at index ${i}: ${line}`);
                    // 다음 줄에서 sha512 찾기
                    if (i + 1 < lines.length && lines[i + 1].includes('sha512:')) {
                        const sha512 = lines[i + 1].split('sha512:')[1].trim();
                        console.log(`✅ Found SHA512 from yml: ${sha512.substring(0, 20)}...`);
                        return sha512;
                    } else {
                        console.log(`❌ No sha512 line found after url line`);
                        console.log(`Next line: ${i + 1 < lines.length ? lines[i + 1] : 'EOF'}`);
                    }
                }
            }

            console.log(`❌ Asset ${assetName} not found in yml file`);
            console.log(`Available lines with 'url:' in yml:`);
            lines.forEach((line, index) => {
                if (line.includes('url:')) {
                    console.log(`  Line ${index}: ${line}`);
                }
            });
        }

        // yml에서 찾지 못했으면 실패
        throw new Error(`SHA512 not found in yml for ${asset.name}`);
    } catch (error) {
        console.error(`❌ Failed to get SHA512 from yml:`, error.message);
        throw error;
    }
}

syncReleaseToSupabase();
