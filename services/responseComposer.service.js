

export const responseComposerService = {
    composeResponse,
}

async function composeResponse(newsAnalysis=null, technicalAnalysis=null) {
    if (!newsAnalysis && !technicalAnalysis) return null
    if (newsAnalysis) {
        return newsAnalysis
    }
    if (technicalAnalysis) {
        return technicalAnalysis
    }
}